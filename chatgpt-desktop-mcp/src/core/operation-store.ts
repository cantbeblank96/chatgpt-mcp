/**
 * Operation store (design doc §12.1): idempotency by request_id.
 * Prevents double-send when an MCP client retries after a lost response.
 * Persisted as a minimal-permission JSON file under stateDir.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logging/logger.js';

export type OperationState = 'in_progress' | 'committed' | 'succeeded' | 'failed' | 'unknown_commit';

export interface OperationRecord {
  requestId: string;
  state: OperationState;
  startedAt: string;
  updatedAt: string;
  conversationHandle?: string;
  promptLen?: number;
  /** sha-1 of the reply text */
  replyHash?: string;
  replyLen?: number;
  /** cached reply text so a retried request_id can replay the same result (0600 local file) */
  replyText?: string;
  errorCode?: string;
}

const MAX_RECORDS = 500;

export class OperationStore {
  private file: string;
  private records = new Map<string, OperationRecord>();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.file = join(stateDir, 'operations.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const arr = JSON.parse(readFileSync(this.file, 'utf8')) as OperationRecord[];
      for (const r of arr.slice(-MAX_RECORDS)) this.records.set(r.requestId, r);
    } catch (e) {
      logger.warn('operation store unreadable, starting fresh', { err: String(e) });
    }
  }

  private persist(): void {
    try {
      const arr = [...this.records.values()].slice(-MAX_RECORDS);
      writeFileSync(this.file, JSON.stringify(arr, null, 1), { mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch (e) {
      logger.warn('operation store persist failed', { err: String(e) });
    }
  }

  get(requestId: string): OperationRecord | undefined {
    return this.records.get(requestId);
  }

  update(requestId: string, patch: Partial<OperationRecord>): OperationRecord {
    const now = new Date().toISOString();
    const prev = this.records.get(requestId);
    const rec: OperationRecord = {
      requestId,
      state: patch.state ?? prev?.state ?? 'in_progress',
      startedAt: prev?.startedAt ?? now,
      updatedAt: now,
      conversationHandle: patch.conversationHandle ?? prev?.conversationHandle,
      promptLen: patch.promptLen ?? prev?.promptLen,
      replyHash: patch.replyHash ?? prev?.replyHash,
      replyLen: patch.replyLen ?? prev?.replyLen,
      replyText: patch.replyText ?? prev?.replyText,
      errorCode: patch.errorCode ?? prev?.errorCode,
    };
    this.records.set(requestId, rec);
    this.persist();
    return rec;
  }

  /** In-flight (non-terminal) operation with same request_id → caller must not re-send. */
  isInFlight(requestId: string): boolean {
    const r = this.records.get(requestId);
    return r?.state === 'in_progress' || r?.state === 'committed' || r?.state === 'unknown_commit';
  }
}
