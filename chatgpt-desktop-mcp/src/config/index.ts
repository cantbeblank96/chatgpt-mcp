/**
 * Runtime configuration. All values can be overridden via environment
 * variables so deployments never need code changes.
 */
export interface AppConfig {
  /** Absolute path to the system python3 (must have gi Atspi/Gtk). */
  pythonPath: string;
  /** Path to atspi_worker.py. Defaults to the bundled copy under dist/. */
  workerScript: string | null;
  /** Default timeout for chatgpt_ask, milliseconds. */
  askTimeoutMs: number;
  /** Response text must be unchanged for this long before we treat it final. */
  stabilizationMs: number;
  /** Poll interval while waiting for the reply, milliseconds. */
  pollIntervalMs: number;
  /** Per-sidecar-call timeout for non-wait operations, milliseconds. */
  sidecarCallTimeoutMs: number;
  /** Directory for local state (operation store, conversation store). */
  stateDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Log full prompt/response text (default false; only lengths are logged). */
  logFullContent: boolean;
  complianceMode: 'poc_only';
}

function intEnv(name: string, dflt: number): number {
  const v = process.env[name];
  if (!v) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function loadConfig(): AppConfig {
  const home = process.env.HOME ?? '/tmp';
  return {
    pythonPath: process.env.CDGMCP_PYTHON ?? '/usr/bin/python3',
    workerScript: process.env.CDGMCP_WORKER_SCRIPT ?? null,
    askTimeoutMs: intEnv('CDGMCP_ASK_TIMEOUT_MS', 180_000),
    stabilizationMs: intEnv('CDGMCP_STABILIZATION_MS', 1000),
    pollIntervalMs: intEnv('CDGMCP_POLL_INTERVAL_MS', 500),
    sidecarCallTimeoutMs: intEnv('CDGMCP_SIDECAR_CALL_TIMEOUT_MS', 30_000),
    stateDir: process.env.CDGMCP_STATE_DIR ?? `${home}/.local/share/chatgpt-mcp`,
    logLevel: (process.env.CDGMCP_LOG_LEVEL as AppConfig['logLevel']) ?? 'info',
    logFullContent: process.env.CDGMCP_LOG_FULL_CONTENT === '1',
    complianceMode: 'poc_only',
  };
}
