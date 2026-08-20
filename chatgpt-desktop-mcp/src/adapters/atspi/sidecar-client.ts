/**
 * JSONL-over-stdio client for the Python AT-SPI sidecar (atspi_worker.py).
 * The sidecar is the ONLY component that talks to AT-SPI / xdotool.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AdapterError, type ErrorCode } from '../../core/errors.js';
import { logger } from '../../logging/logger.js';

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: AdapterError) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class SidecarClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private alive = false;
  private exitReason: string | null = null;

  constructor(
    private pythonPath: string,
    private scriptPath: string,
    private defaultTimeoutMs: number,
  ) {}

  async start(): Promise<void> {
    if (this.alive) return;
    this.exitReason = null;
    const proc = spawn(this.pythonPath, [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.proc = proc;

    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new AdapterError('ADAPTER_BROKEN', 'sidecar did not become ready within 15s')), 15_000);
      proc.once('error', (e) => {
        clearTimeout(t);
        reject(new AdapterError('ADAPTER_BROKEN', `failed to spawn sidecar: ${e.message}`, {
          python: this.pythonPath,
          script: this.scriptPath,
          hint: 'sidecar must run under system python3 with gi (Atspi/Gtk); check ADR-001',
        }));
      });
      proc.once('exit', (code) => {
        clearTimeout(t);
        reject(new AdapterError('ADAPTER_BROKEN', `sidecar exited before ready (code=${code})`));
      });
      proc.stdout!.once('data', (buf: Buffer) => {
        const first = buf.toString().split('\n')[0];
        try {
          const msg = JSON.parse(first);
          if (msg.event === 'ready') {
            clearTimeout(t);
            resolve();
            return;
          }
        } catch {
          /* fall through */
        }
        clearTimeout(t);
        reject(new AdapterError('ADAPTER_BROKEN', 'unexpected sidecar handshake', { line: first.slice(0, 200) }));
      });
    });

    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => this.onLine(line));
    proc.stderr!.on('data', (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        if (line.trim()) logger.debug('sidecar: ' + line.trim());
      }
    });
    proc.on('exit', (code, signalName) => {
      this.alive = false;
      this.exitReason = `sidecar exited (code=${code}, signal=${signalName})`;
      const err = new AdapterError('ADAPTER_BROKEN', this.exitReason);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });

    await ready;
    this.alive = true;
    logger.info('sidecar ready', { python: this.pythonPath });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string; details?: Record<string, unknown> } };
    try {
      msg = JSON.parse(line);
    } catch {
      logger.warn('sidecar sent non-JSON line', { line: line.slice(0, 200) });
      return;
    }
    const id = msg.id;
    if (id === undefined) return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.ok) {
      p.resolve(msg.result);
    } else {
      const code = (msg.error?.code ?? 'SIDECAR_ERROR') as ErrorCode;
      p.reject(new AdapterError(code, msg.error?.message ?? 'sidecar error', msg.error?.details ?? {}));
    }
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (!this.alive || !this.proc || this.proc.exitCode !== null) {
      // lazy restart: sidecar may have died between calls
      await this.start();
    }
    const id = ++this.seq;
    const body = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterError('SIDECAR_ERROR', `sidecar call timed out: ${method}`, { timeout_ms: timeoutMs ?? this.defaultTimeoutMs }));
      }, timeoutMs ?? this.defaultTimeoutMs);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer, method });
      this.proc!.stdin!.write(body + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new AdapterError('ADAPTER_BROKEN', `failed writing to sidecar: ${err.message}`));
        }
      });
    });
  }

  dispose(): void {
    this.alive = false;
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
    }
    this.proc = null;
  }
}
