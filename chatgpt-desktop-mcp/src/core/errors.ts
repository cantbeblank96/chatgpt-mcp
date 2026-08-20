/**
 * Structured error model (design doc §13).
 * All errors carry diagnostic metadata; never credentials.
 */
export type ErrorCode =
  | 'APP_NOT_RUNNING'
  | 'AUTH_REQUIRED'
  | 'SURFACE_NOT_FOUND'
  | 'SURFACE_AMBIGUOUS'
  | 'COMPOSER_NOT_FOUND'
  | 'COMPOSER_SET_FAILED'
  | 'PROMPT_COMMIT_FAILED'
  | 'GENERATION_TIMEOUT'
  | 'GENERATION_CANCELLED'
  | 'GENERATION_IN_PROGRESS'
  | 'RATE_LIMITED'
  | 'RESPONSE_NOT_FOUND'
  | 'CONVERSATION_STALE'
  | 'CONVERSATION_AMBIGUOUS'
  | 'CONVERSATION_NOT_FOUND'
  | 'USER_INTERFERENCE_DETECTED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'ADAPTER_BROKEN'
  | 'UNKNOWN_COMMIT_STATE'
  | 'OPERATION_IN_PROGRESS'
  | 'SIDECAR_ERROR'
  | 'INTERNAL';

export class AdapterError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isAdapterError(e: unknown, code?: ErrorCode): e is AdapterError {
  return e instanceof AdapterError && (code === undefined || e.code === code);
}

/** Map an unknown thrown value to a structured AdapterError. */
export function toAdapterError(e: unknown, fallbackCode: ErrorCode = 'INTERNAL'): AdapterError {
  if (e instanceof AdapterError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new AdapterError(fallbackCode, msg);
}
