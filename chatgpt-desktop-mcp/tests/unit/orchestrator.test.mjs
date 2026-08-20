import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../../dist/core/orchestrator.js';
import { Mutex } from '../../dist/core/mutex.js';
import { OperationStore } from '../../dist/core/operation-store.js';
import { ConversationStore } from '../../dist/core/conversation-store.js';
import { AdapterError } from '../../dist/core/errors.js';

/** In-memory fake implementing the ChatGPTAdapter contract. */
class FakeAdapter {
  constructor() {
    this.name = 'fake';
    this.sendCalls = 0;
    this.messages = []; // [{role, text}]
    this.generating = false;
    this.commitShouldBe = 'ok'; // 'ok' | 'unknown'
    this.mode = 'ChatGPT';
  }

  fingerprint() {
    return `fp-${this.messages.length}`;
  }

  async probe() {
    return { adapter: this.name, ok: true, checks: {}, problems: [], hints: [] };
  }

  async health() {
    return {
      appRunning: true, pid: 1, a11yFlagPresent: true, surfaceFound: true,
      composerFound: true, mode: this.mode, generating: this.generating,
      messageCount: this.messages.length,
    };
  }

  async ensureChatSurface() {}

  async newChat() {
    this.messages = [];
    return { messageCount: 0 };
  }

  async getState() {
    return {
      surfaceFound: true,
      composerFound: true,
      composerText: '',
      generating: this.generating,
      statusBars: [],
      messages: [...this.messages],
      mode: this.mode,
      userCount: this.messages.filter((m) => m.role === 'user').length,
      assistantCount: this.messages.filter((m) => m.role === 'assistant').length,
      fingerprint: this.fingerprint(),
    };
  }

  async setComposer() {}

  async sendPrompt(prompt) {
    this.sendCalls += 1;
    if (this.commitShouldBe === 'unknown') {
      throw new AdapterError('UNKNOWN_COMMIT_STATE', 'cannot verify commit');
    }
    this.messages.push({ role: 'user', text: prompt });
    this.messages.push({ role: 'assistant', text: `reply to: ${prompt}` });
    return { committed: true, via: 'button', userCount: this.messages.length, generating: false };
  }

  async waitForFinalResponse(baseline) {
    const last = this.messages[this.messages.length - 1];
    return { text: last.text, userIndex: baseline.userCount, assistantIndex: 0, durationMs: 1 };
  }

  async cancel() {
    return true;
  }

  async listConversations() {
    return { titles: ['conv-a', 'conv-b'], count: 2 };
  }

  dispose() {}
}

function makeOrch(adapter) {
  const dir = mkdtempSync(join(tmpdir(), 'cdgmcp-orch-'));
  return new Orchestrator({
    adapter,
    mutex: new Mutex(),
    ops: new OperationStore(dir),
    conversations: new ConversationStore(dir),
    askTimeoutMs: 5000,
    stabilizationMs: 10,
    pollIntervalMs: 10,
  });
}

test('ask returns the NEW reply with a conversation handle', async () => {
  const adapter = new FakeAdapter();
  const orch = makeOrch(adapter);
  const r = await orch.ask({ prompt: 'hello', requestId: 'r-1' });
  assert.equal(r.ok, true);
  assert.match(r.conversation_handle, /^cgpt_[a-f0-9]{16}$/);
  assert.equal(r.text, 'reply to: hello');
  assert.equal(adapter.sendCalls, 1);
});

test('retried request_id NEVER re-sends (idempotent replay)', async () => {
  const adapter = new FakeAdapter();
  const orch = makeOrch(adapter);
  const first = await orch.ask({ prompt: 'hello', requestId: 'r-dup' });
  const second = await orch.ask({ prompt: 'hello', requestId: 'r-dup' });
  assert.equal(adapter.sendCalls, 1, 'sendPrompt must run exactly once');
  assert.equal(second.replayed, true);
  assert.equal(second.text, first.text);
});

test('UNKNOWN_COMMIT_STATE is surfaced and recorded, not auto-retried', async () => {
  const adapter = new FakeAdapter();
  adapter.commitShouldBe = 'unknown';
  const orch = makeOrch(adapter);
  await assert.rejects(
    orch.ask({ prompt: 'hello', requestId: 'r-unknown' }),
    (e) => e instanceof AdapterError && e.code === 'UNKNOWN_COMMIT_STATE',
  );
  // same request_id still must not re-send
  await assert.rejects(
    orch.ask({ prompt: 'hello', requestId: 'r-unknown' }),
    (e) => e instanceof AdapterError && e.code === 'OPERATION_IN_PROGRESS',
  );
  assert.equal(adapter.sendCalls, 1);
});

test('continue verifies conversation fingerprint (CONVERSATION_STALE)', async () => {
  const adapter = new FakeAdapter();
  const orch = makeOrch(adapter);
  const r1 = await orch.ask({ prompt: 'first', requestId: 'r-a' });
  // user switched conversations behind our back
  adapter.messages = [{ role: 'user', text: 'someone elses chat' }];
  await assert.rejects(
    orch.ask({ prompt: 'second', conversationHandle: r1.conversation_handle, requestId: 'r-b' }),
    (e) => e instanceof AdapterError && e.code === 'CONVERSATION_STALE',
  );
});

test('fingerprint churn (virtualization) does not false-positive CONVERSATION_STALE while our anchor prompt is visible', async () => {
  const adapter = new FakeAdapter();
  const orch = makeOrch(adapter);
  const r1 = await orch.ask({ prompt: 'first', requestId: 'r-v1' });
  // simulate a long conversation: older messages virtualized away, tail
  // contains our last prompt; fingerprint necessarily differs
  adapter.messages = [
    { role: 'user', text: 'first' },
    { role: 'assistant', text: 'reply to: first' },
  ];
  adapter.fingerprint = () => 'fp-virtualized-churn';
  const r2 = await orch.ask({ prompt: 'second', conversationHandle: r1.conversation_handle, requestId: 'r-v2' });
  assert.equal(r2.ok, true);
  assert.equal(adapter.sendCalls, 2);
});

test('busy generation is rejected, not interrupted', async () => {
  const adapter = new FakeAdapter();
  adapter.generating = true;
  const orch = makeOrch(adapter);
  await assert.rejects(
    orch.ask({ prompt: 'hello', requestId: 'r-busy' }),
    (e) => e instanceof AdapterError && e.code === 'GENERATION_IN_PROGRESS',
  );
  assert.equal(adapter.sendCalls, 0);
});

test('concurrent asks are serialized by the mutex', async () => {
  const adapter = new FakeAdapter();
  const orch = makeOrch(adapter);
  const [r1, r2] = await Promise.all([
    orch.ask({ prompt: 'one', requestId: 'r-c1' }),
    orch.ask({ prompt: 'two', requestId: 'r-c2' }),
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(adapter.sendCalls, 2);
});

test('cancel delegates to adapter and reports result', async () => {
  const adapter = new FakeAdapter();
  const orch = makeOrch(adapter);
  const r = await orch.cancel();
  assert.equal(r.cancelled, true);
});

test('listConversations returns sidebar titles read-only', async () => {
  const adapter = new FakeAdapter();
  const orch = makeOrch(adapter);
  const r = await orch.listConversations();
  assert.deepEqual(r.conversations, ['conv-a', 'conv-b']);
  assert.equal(r.count, 2);
  assert.equal(adapter.sendCalls, 0, 'listing must never send');
});
