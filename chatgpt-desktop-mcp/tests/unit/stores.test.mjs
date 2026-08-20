import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationStore } from '../../dist/core/operation-store.js';
import { ConversationStore } from '../../dist/core/conversation-store.js';

function tmpState() {
  return mkdtempSync(join(tmpdir(), 'cdgmcp-test-'));
}

test('operation store tracks state and detects in-flight ops', () => {
  const ops = new OperationStore(tmpState());
  ops.update('req-1', { state: 'in_progress', promptLen: 10 });
  assert.equal(ops.isInFlight('req-1'), true);
  ops.update('req-1', { state: 'committed' });
  assert.equal(ops.isInFlight('req-1'), true);
  ops.update('req-1', { state: 'unknown_commit' });
  assert.equal(ops.isInFlight('req-1'), true);
  ops.update('req-1', { state: 'succeeded', replyText: 'x' });
  assert.equal(ops.isInFlight('req-1'), false);
  assert.equal(ops.get('req-1').replyText, 'x');
});

test('operation store survives restart (persistence)', () => {
  const dir = tmpState();
  const ops1 = new OperationStore(dir);
  ops1.update('req-9', { state: 'succeeded', replyText: 'cached', conversationHandle: 'cgpt_123' });
  const ops2 = new OperationStore(dir);
  const rec = ops2.get('req-9');
  assert.equal(rec.state, 'succeeded');
  assert.equal(rec.replyText, 'cached');
});

test('conversation store issues cgpt_ handles and rejects unknown ones', () => {
  const convs = new ConversationStore(tmpState());
  const rec = convs.create();
  assert.match(rec.handle, /^cgpt_[a-f0-9]{16}$/);
  assert.equal(convs.get(rec.handle).handle, rec.handle);
  assert.throws(() => convs.get('cgpt_doesnotexist0000'), /CONVERSATION_NOT_FOUND|unknown conversation_handle/);
});
