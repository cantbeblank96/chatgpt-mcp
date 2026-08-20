/**
 * AT-SPI adapter (ADR-001 decision, plan B).
 * Delegates all accessibility / window / clipboard interaction to the
 * Python sidecar; this class implements the ChatGPTAdapter contract and
 * the multi-signal completion wait (never a fixed sleep).
 */
import { AdapterError } from '../../core/errors.js';
import { logger, redact } from '../../logging/logger.js';
import type {
  Baseline,
  ChatGPTAdapter,
  ChatSurfaceState,
  CommitResult,
  FinalResponse,
  HealthInfo,
  ProbeResult,
  WaitOptions,
} from '../interface.js';
import { normalizeText } from '../interface.js';
import type { SidecarClient } from './sidecar-client.js';

interface RawState {
  surface_found?: boolean;
  composer_found?: boolean;
  composer_text?: string;
  generating?: boolean;
  status_bars?: string[];
  messages?: { role: 'user' | 'assistant'; text: string }[];
  mode?: string | null;
  user_count?: number;
  assistant_count?: number;
  error_banner?: string | null;
  fingerprint?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AtspiAdapter implements ChatGPTAdapter {
  readonly name = 'atspi';

  constructor(private sidecar: SidecarClient) {}

  private mapState(raw: RawState): ChatSurfaceState {
    return {
      surfaceFound: raw.surface_found ?? true,
      composerFound: raw.composer_found ?? false,
      composerText: normalizeText(raw.composer_text),
      generating: raw.generating ?? false,
      statusBars: raw.status_bars ?? [],
      messages: raw.messages ?? [],
      mode: raw.mode ?? null,
      userCount: raw.user_count ?? 0,
      assistantCount: raw.assistant_count ?? 0,
      errorBanner: raw.error_banner ?? null,
      fingerprint: raw.fingerprint ?? '',
    };
  }

  async probe(): Promise<ProbeResult> {
    const problems: string[] = [];
    const hints: string[] = [];
    const checks: Record<string, unknown> = {};
    try {
      const h = await this.sidecar.call<Record<string, unknown>>('health');
      Object.assign(checks, h);
      if (h.a11y_flag_present === false) {
        problems.push('ChatGPT Desktop is running without --force-renderer-accessibility');
        hints.push('Relaunch ChatGPT Desktop with --force-renderer-accessibility (user consent required).');
      }
      if (h.composer_found === false) {
        problems.push('composer entry not found in the ChatGPT frame');
      }
    } catch (e) {
      const err = e instanceof AdapterError ? e : new AdapterError('INTERNAL', String(e));
      problems.push(`${err.code}: ${err.message}`);
      if (err.code === 'APP_NOT_RUNNING') hints.push('Start ChatGPT Desktop and log in, then retry.');
      if (err.code === 'ADAPTER_BROKEN') {
        hints.push('Relaunch ChatGPT Desktop with --force-renderer-accessibility (user consent required).');
      }
    }
    return { adapter: this.name, ok: problems.length === 0, checks, problems, hints };
  }

  async health(): Promise<HealthInfo> {
    try {
      const raw = await this.sidecar.call<Record<string, unknown>>('health');
      return {
        appRunning: (raw.app_running as boolean) ?? false,
        pid: (raw.pid as number) ?? null,
        a11yFlagPresent: (raw.a11y_flag_present as boolean) ?? false,
        surfaceFound: (raw.surface_found as boolean) ?? false,
        composerFound: (raw.composer_found as boolean) ?? false,
        mode: (raw.mode as string | null) ?? null,
        generating: (raw.generating as boolean) ?? false,
        messageCount: (raw.message_count as number) ?? 0,
      };
    } catch (e) {
      // surface the structured error but also provide a degraded health view
      if (e instanceof AdapterError && (e.code === 'APP_NOT_RUNNING' || e.code === 'ADAPTER_BROKEN' || e.code === 'SURFACE_NOT_FOUND')) {
        throw e;
      }
      throw e;
    }
  }

  async ensureChatSurface(): Promise<void> {
    const h = await this.health();
    if (!h.appRunning) {
      throw new AdapterError('APP_NOT_RUNNING', 'ChatGPT Desktop process not found');
    }
    if (!h.a11yFlagPresent) {
      throw new AdapterError('ADAPTER_BROKEN',
        'renderer accessibility not active: ChatGPT Desktop must be launched with --force-renderer-accessibility',
        { hint: 'restart the app with the flag (requires user consent)' });
    }
    if (!h.surfaceFound || !h.composerFound) {
      throw new AdapterError('SURFACE_NOT_FOUND', 'plain Chat surface or composer not found', {
        surfaceFound: h.surfaceFound,
        composerFound: h.composerFound,
      });
    }
  }

  async newChat(): Promise<{ messageCount: number }> {
    const raw = await this.sidecar.call<{ message_count?: number }>('new_chat');
    return { messageCount: raw.message_count ?? 0 };
  }

  async getState(includeMessages = true): Promise<ChatSurfaceState> {
    const raw = await this.sidecar.call<RawState>('get_state', { include_messages: includeMessages });
    return this.mapState(raw);
  }

  async setComposer(text: string): Promise<void> {
    await this.sidecar.call('composer_set', { text });
  }

  async sendPrompt(prompt: string): Promise<CommitResult> {
    // Fill composer first (idempotent: clears residual text), verify readback.
    await this.setComposer(prompt);
    const raw = await this.sidecar.call<{ committed: boolean; via?: string; user_count?: number; generating?: boolean; reason?: string }>('send');
    if (!raw.committed) {
      throw new AdapterError('PROMPT_COMMIT_FAILED', `prompt was not committed: ${raw.reason ?? 'unknown'}`, {
        via: raw.via,
        prompt: redact(prompt),
      });
    }
    logger.info('prompt committed', { via: raw.via, prompt: redact(prompt) });
    return {
      committed: true,
      via: raw.via === 'enter' ? 'enter' : 'button',
      userCount: raw.user_count ?? 0,
      generating: raw.generating ?? false,
    };
  }

  async waitForFinalResponse(baseline: Baseline, opts: WaitOptions): Promise<FinalResponse> {
    const startedAt = Date.now();
    const deadline = startedAt + opts.timeoutMs;
    let stableText: string | null = null;
    let stableSince = 0;
    let modeMismatchStreak = 0;
    let wrongLastUserStreak = 0;
    let sawGenerating = false;
    let cancelledStreak = 0;

    while (Date.now() < deadline) {
      await sleep(opts.pollIntervalMs);
      let st: ChatSurfaceState;
      try {
        st = await this.getState(true);
      } catch (e) {
        if (e instanceof AdapterError && e.code === 'APP_NOT_RUNNING') throw e;
        logger.warn('transient getState failure while waiting', { err: String(e) });
        continue;
      }

      // --- service-side error banner (rate limit / outage): fail fast with a
      //     structured code instead of burning the whole generation timeout.
      //     Only a banner NEW since commit counts; a banner already visible at
      //     baseline is stale UI residue from an earlier failure.
      if (st.errorBanner && st.errorBanner !== baseline.errorBanner) {
        throw new AdapterError('RATE_LIMITED', `ChatGPT service reported an error: ${st.errorBanner}`, {
          banner: st.errorBanner,
          phase: 'wait',
        });
      }

      // --- user interference / conversation drift detection (debounced:
      //     a11y scans can transiently mis-read during UI churn)
      if (st.mode !== null && baseline.mode !== null && st.mode !== baseline.mode) {
        if (++modeMismatchStreak >= 2) {
          throw new AdapterError('USER_INTERFERENCE_DETECTED', 'mode switched while waiting for response', {
            before: baseline.mode, after: st.mode,
          });
        }
      } else {
        modeMismatchStreak = 0;
      }

      // --- structural reply detection: an assistant message AFTER our user
      //     message in the visible list. Absolute message-count deltas are
      //     NOT reliable: the list virtualizes (~14 items rendered) and
      //     unloads older messages, so counts plateau on long conversations.
      let myUserIdx = -1;
      for (let i = st.messages.length - 1; i >= 0; i--) {
        const m = st.messages[i];
        if (m.role !== 'user') continue;
        if (baseline.promptNorm && normalizeText(m.text) === baseline.promptNorm) myUserIdx = i;
        break; // only the most recent user message is our candidate
      }
      if (myUserIdx === -1) {
        const lastUser = [...st.messages].reverse().find((m) => m.role === 'user');
        if (lastUser && baseline.promptNorm && st.userCount > baseline.userCount) {
          // a user message exists, is visible, and is not ours -> someone sent
          // something else (debounced against render transients)
          if (++wrongLastUserStreak >= 2) {
            throw new AdapterError('USER_INTERFERENCE_DETECTED',
              'latest user message does not match the submitted prompt', {
              expectedLen: baseline.promptNorm.length,
              actualLen: normalizeText(lastUser.text).length,
            });
          }
        }
      } else {
        wrongLastUserStreak = 0;
      }

      const reply = myUserIdx >= 0
        ? [...st.messages].slice(myUserIdx + 1).reverse().find((m) => m.role === 'assistant')
        : undefined;

      // --- interruption detection: we saw the generation running, it stopped,
      //     yet no assistant reply ever rendered (chatgpt_cancel pressed before
      //     first token). Fail fast instead of burning the whole timeout.
      if (st.generating) {
        sawGenerating = true;
        cancelledStreak = 0;
      } else if (sawGenerating && myUserIdx >= 0 && !reply) {
        if (++cancelledStreak >= 2) {
          throw new AdapterError('GENERATION_CANCELLED',
            'generation was interrupted before producing a visible reply (chatgpt_cancel?)', {
              phase: 'wait',
            });
        }
      } else {
        cancelledStreak = 0;
      }

      if (!st.generating && myUserIdx >= 0 && reply) {
        const text = normalizeText(reply.text);
        if (text.length === 0) continue;
        if (text === stableText) {
          if (Date.now() - stableSince >= opts.stabilizationMs) {
            return {
              text,
              userIndex: st.userCount - 1,
              assistantIndex: st.assistantCount - 1,
              durationMs: Date.now() - startedAt,
            };
          }
        } else {
          stableText = text;
          stableSince = Date.now();
        }
        continue;
      }
      // still generating or reply not rendered yet: reset stability window
      stableText = null;
      stableSince = 0;
    }

    throw new AdapterError('GENERATION_TIMEOUT', 'response did not complete within timeout', {
      timeout_ms: opts.timeoutMs,
      baseline_user_count: baseline.userCount,
    });
  }

  async cancel(): Promise<boolean> {
    const raw = await this.sidecar.call<{ cancelled: boolean }>('cancel');
    return raw.cancelled;
  }

  async listConversations(limit = 50): Promise<{ titles: string[]; count: number }> {
    const raw = await this.sidecar.call<{ conversations?: string[]; count?: number }>(
      'list_conversations', { limit });
    return { titles: raw.conversations ?? [], count: raw.count ?? (raw.conversations ?? []).length };
  }

  dispose(): void {
    this.sidecar.dispose();
  }
}
