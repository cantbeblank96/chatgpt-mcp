/**
 * ChatGPTAdapter abstraction (design doc §7).
 * The MCP layer NEVER touches AT-SPI roles, DOM selectors, window titles,
 * keyboard or mouse directly — everything goes through this interface.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatSurfaceState {
  surfaceFound: boolean;
  composerFound: boolean;
  composerText: string;
  generating: boolean;
  statusBars: string[];
  messages: ChatMessage[];
  /** Mode shown by the mode selector, e.g. "ChatGPT" (plain Chat). */
  mode: string | null;
  userCount: number;
  assistantCount: number;
  /** text of a visible service-side error banner (rate limit etc.), if any */
  errorBanner: string | null;
  /** SHA-1 over [role, text-prefix] pairs — stable conversation identity. */
  fingerprint: string;
}

export interface HealthInfo {
  appRunning: boolean;
  pid: number | null;
  a11yFlagPresent: boolean;
  surfaceFound: boolean;
  composerFound: boolean;
  mode: string | null;
  generating: boolean;
  messageCount: number;
}

export interface ProbeResult {
  adapter: string;
  ok: boolean;
  checks: Record<string, unknown>;
  problems: string[];
  hints: string[];
}

export interface CommitResult {
  committed: boolean;
  via: 'button' | 'enter';
  userCount: number;
  generating: boolean;
  reason?: string;
}

export interface Baseline {
  fingerprint: string;
  userCount: number;
  assistantCount: number;
  mode: string | null;
  /** normalized prompt expected as the next user message */
  promptNorm: string;
  /** service error banner already visible BEFORE commit (stale; ignored) */
  errorBanner: string | null;
}

export interface FinalResponse {
  text: string;
  /** which user message index (0-based) this reply belongs to */
  userIndex: number;
  assistantIndex: number;
  durationMs: number;
}

export interface WaitOptions {
  timeoutMs: number;
  stabilizationMs: number;
  pollIntervalMs: number;
}

export interface ChatGPTAdapter {
  readonly name: string;

  /** One-shot capability probe (does not mutate the UI). */
  probe(): Promise<ProbeResult>;
  /** Structured health of app + surface + composer. */
  health(): Promise<HealthInfo>;
  /** Verify the plain-Chat surface is present and usable; throws otherwise. */
  ensureChatSurface(): Promise<void>;
  /** Click New Chat and wait for a fresh composer. */
  newChat(): Promise<{ messageCount: number }>;
  /** Read-only snapshot of the current surface. */
  getState(includeMessages?: boolean): Promise<ChatSurfaceState>;
  /** Fill the composer with the prompt (clipboard paste) and verify readback. */
  setComposer(text: string): Promise<void>;
  /** Press Send and verify commit. Throws UNKNOWN_COMMIT_STATE when unclear. */
  sendPrompt(prompt: string): Promise<CommitResult>;
  /**
   * Wait until a NEW assistant reply for the given baseline is complete.
   * Completion = new assistant message exists AND generation inactive AND
   * text stable for stabilizationMs. Never a fixed sleep.
   */
  waitForFinalResponse(baseline: Baseline, opts: WaitOptions): Promise<FinalResponse>;
  /** Press Stop if a generation is in flight. */
  cancel(): Promise<boolean>;
  /** Read-only: enumerate visible sidebar conversation titles (recent list). */
  listConversations(limit?: number): Promise<{ titles: string[]; count: number }>;
  dispose(): void;
}

export function normalizeText(t: string | null | undefined): string {
  if (!t) return '';
  return t.replaceAll('\ufffc', '').trim();
}
