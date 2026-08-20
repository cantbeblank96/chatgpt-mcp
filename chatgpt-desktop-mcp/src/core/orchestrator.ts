/**
 * Orchestrator: the only place that sequences adapter primitives into
 * business operations. Enforces the global mutex, request_id idempotency,
 * baseline/fingerprint correctness and structured failures.
 */
import { createHash } from 'node:crypto';
import type { ChatGPTAdapter, HealthInfo, ProbeResult } from '../adapters/interface.js';
import { normalizeText } from '../adapters/interface.js';
import type { ConversationStore } from './conversation-store.js';
import { AdapterError, toAdapterError } from './errors.js';
import type { Mutex } from './mutex.js';
import type { OperationStore } from './operation-store.js';
import { logger, redact } from '../logging/logger.js';

export interface AskInput {
  prompt: string;
  conversationHandle?: string;
  newChat?: boolean;
  mode?: 'auto';
  timeoutMs?: number;
  requestId?: string;
}

export interface AskResult {
  ok: true;
  conversation_handle: string;
  message_id: string;
  text: string;
  adapter: string;
  duration_ms: number;
  warnings: string[];
  replayed?: boolean;
}

export interface OrchestratorDeps {
  adapter: ChatGPTAdapter;
  mutex: Mutex;
  ops: OperationStore;
  conversations: ConversationStore;
  askTimeoutMs: number;
  stabilizationMs: number;
  pollIntervalMs: number;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  async health(): Promise<HealthInfo> {
    return this.deps.adapter.health();
  }

  async probe(): Promise<ProbeResult> {
    return this.deps.adapter.probe();
  }

  /** Press Stop on an in-flight generation (no-op when idle).
   *
   * Deliberately NOT under the global mutex: a long-running ask holds the
   * mutex while waiting, and cancel must still reach the GUI to interrupt
   * it. The sidecar serializes its own RPCs, so concurrent GUI access stays
   * safe. After a cancel, the in-flight ask either returns the partial
   * reply (ChatGPT keeps stopped output) or times out. */
  async cancel(): Promise<{ cancelled: boolean }> {
    const cancelled = await this.deps.adapter.cancel();
    logger.info('cancel requested', { cancelled });
    return { cancelled };
  }

  /** Read-only enumeration of visible sidebar conversation titles. */
  async listConversations(limit?: number): Promise<{ conversations: string[]; count: number }> {
    const r = await this.deps.adapter.listConversations(limit);
    return { conversations: r.titles, count: r.count };
  }

  async newChat(requestId?: string): Promise<{ conversation_handle: string; message_count: number }> {
    const { adapter, mutex, ops, conversations } = this.deps;
    if (requestId) {
      if (ops.isInFlight(requestId)) {
        throw new AdapterError('OPERATION_IN_PROGRESS',
          'an operation with this request_id is still in flight; not re-executing', { request_id: requestId });
      }
    }
    return mutex.runExclusive(async () => {
      if (requestId) ops.update(requestId, { state: 'in_progress' });
      try {
        await adapter.ensureChatSurface();
        const r = await adapter.newChat();
        const rec = conversations.create();
        const state = await adapter.getState(true);
        conversations.update(rec.handle, {
          lastFingerprint: state.fingerprint,
          lastUserCount: state.userCount,
          lastAssistantCount: state.assistantCount,
        });
        if (requestId) ops.update(requestId, { state: 'succeeded', conversationHandle: rec.handle });
        return { conversation_handle: rec.handle, message_count: r.messageCount };
      } catch (e) {
        const err = toAdapterError(e);
        if (requestId) ops.update(requestId, { state: 'failed', errorCode: err.code });
        throw err;
      }
    });
  }

  async ask(input: AskInput): Promise<AskResult> {
    const { adapter, mutex, ops, conversations } = this.deps;
    const prompt = input.prompt?.trim();
    if (!prompt) {
      throw new AdapterError('PROMPT_COMMIT_FAILED', 'prompt is empty');
    }
    const requestId = input.requestId;

    // ---- idempotency gate (design doc §12.1): never double-send
    if (requestId) {
      if (ops.isInFlight(requestId)) {
        throw new AdapterError('OPERATION_IN_PROGRESS',
          'an operation with this request_id is still in flight; refusing to re-send. ' +
          'Inspect the ChatGPT Desktop window before retrying with a NEW request_id.',
          { request_id: requestId });
      }
      const prev = ops.get(requestId);
      if (prev?.state === 'succeeded') {
        // idempotent replay: same request_id returns the same result, never re-sends
        return {
          ok: true as const,
          conversation_handle: prev.conversationHandle ?? '',
          message_id: `m_${sha1(`${prev.conversationHandle}:${prev.replyHash ?? ''}`).slice(0, 16)}`,
          text: prev.replyText ?? '',
          adapter: this.deps.adapter.name,
          duration_ms: 0,
          warnings: ['replayed from operation store (request_id already completed)'],
          replayed: true,
        };
      }
    }

    const timeoutMs = input.timeoutMs ?? this.deps.askTimeoutMs;
    const warnings: string[] = [];
    const startedAt = Date.now();

    return mutex.runExclusive(async () => {
      if (requestId) {
        ops.update(requestId, { state: 'in_progress', promptLen: prompt.length, conversationHandle: input.conversationHandle });
      }
      try {
        // ---- surface & mode checks
        await adapter.ensureChatSurface();
        const health = await adapter.health();
        if (health.mode && health.mode.toLowerCase() !== 'chatgpt') {
          throw new AdapterError('UNSUPPORTED_CAPABILITY',
            `current mode is '${health.mode}'; MVP only drives the plain Chat surface`, { mode: health.mode });
        }
        if (health.generating) {
          throw new AdapterError('GENERATION_IN_PROGRESS',
            'ChatGPT is already generating a response; wait for it to finish or cancel', {});
        }
        // service-side error banner already visible: record it in the
        // baseline as stale UI residue (new_chat clears it); a NEW banner
        // appearing after commit will surface as RATE_LIMITED during wait
        const pre = await adapter.getState(false);
        if (pre.errorBanner) {
          logger.warn('stale service error banner visible before send; proceeding', { banner: pre.errorBanner });
        }

        // ---- conversation selection
        let handle = input.conversationHandle;
        let conv = handle ? conversations.get(handle) : undefined;

        if (input.newChat || !handle) {
          await adapter.newChat();
          const rec = conversations.create();
          handle = rec.handle;
          conv = rec;
        } else if (conv?.lastFingerprint || conv?.lastUserPrompt) {
          // continue path: verify the visible conversation still matches our
          // records. Tail fingerprint OR structural anchor (our last prompt
          // visible): long conversations virtualize older messages, which
          // churns fingerprints even when nothing changed.
          const state = await adapter.getState(true);
          const c = conv;
          const fingerprintOk = c.lastFingerprint && state.fingerprint === c.lastFingerprint;
          const anchorOk = c.lastUserPrompt
            && state.messages.some((m) => m.role === 'user' && normalizeText(m.text) === c.lastUserPrompt);
          if (!fingerprintOk && !anchorOk) {
            throw new AdapterError('CONVERSATION_STALE',
              'the visible ChatGPT conversation no longer matches this conversation_handle ' +
              '(user may have switched conversations). Use chatgpt_new_chat or select the conversation manually.',
              { conversation_handle: handle });
          }
        }

        // ---- baseline before commit (design doc §12.2)
        const before = await adapter.getState(true);
        const baseline = {
          fingerprint: before.fingerprint,
          userCount: before.userCount,
          assistantCount: before.assistantCount,
          mode: before.mode,
          promptNorm: normalizeText(prompt),
          errorBanner: before.errorBanner ?? null,
        };

        // ---- commit (never retried automatically)
        let commit;
        try {
          commit = await adapter.sendPrompt(prompt);
        } catch (e) {
          const err = toAdapterError(e);
          if (requestId) {
            ops.update(requestId, {
              state: err.code === 'UNKNOWN_COMMIT_STATE' ? 'unknown_commit' : 'failed',
              errorCode: err.code,
              conversationHandle: handle,
            });
          }
          throw err;
        }
        if (requestId) ops.update(requestId, { state: 'committed', conversationHandle: handle });

        // Record the committed prompt immediately (before waiting) so that a
        // later continue on this handle can anchor on it even if the wait
        // below fails (timeout / cancel): the conversation is still ours.
        conversations.update(handle!, {
          lastUserPrompt: normalizeText(prompt).slice(0, 200),
          lastUserCount: commit.userCount,
        });

        // ---- wait for the NEW reply (multi-signal, never fixed sleep)
        const final = await adapter.waitForFinalResponse(baseline, {
          timeoutMs,
          stabilizationMs: this.deps.stabilizationMs,
          pollIntervalMs: this.deps.pollIntervalMs,
        });

        const afterState = await adapter.getState(false).catch(() => null);
        if (afterState && afterState.fingerprint) {
          conversations.update(handle!, {
            lastFingerprint: afterState.fingerprint,
            lastUserPrompt: normalizeText(prompt).slice(0, 200),
            lastUserCount: afterState.userCount,
            lastAssistantCount: afterState.assistantCount,
            turnCount: (conv?.turnCount ?? 0) + 1,
          });
        }

        const messageId = sha1(`${handle}:${baseline.userCount}:${final.text.slice(0, 64)}`).slice(0, 16);
        if (requestId) {
          ops.update(requestId, {
            state: 'succeeded',
            conversationHandle: handle,
            replyHash: sha1(final.text),
            replyLen: final.text.length,
            replyText: final.text.slice(0, 200_000),
          });
        }
        logger.info('ask completed', {
          request_id: requestId ?? null,
          conversation_handle: handle,
          prompt: redact(prompt),
          reply: redact(final.text),
          duration_ms: Date.now() - startedAt,
          commit_via: commit.via,
        });

        return {
          ok: true as const,
          conversation_handle: handle!,
          message_id: `m_${messageId}`,
          text: final.text,
          adapter: adapter.name,
          duration_ms: Date.now() - startedAt,
          warnings,
        };
      } catch (e) {
        const err = toAdapterError(e);
        if (requestId) {
          const st = ops.get(requestId)?.state;
          if (st !== 'unknown_commit' && st !== 'succeeded') {
            ops.update(requestId, { state: 'failed', errorCode: err.code });
          }
        }
        logger.error('ask failed', { request_id: requestId ?? null, code: err.code, message: err.message });
        throw err;
      }
    });
  }
}
