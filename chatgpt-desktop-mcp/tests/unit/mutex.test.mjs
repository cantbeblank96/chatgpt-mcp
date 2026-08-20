import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mutex } from '../../dist/core/mutex.js';

test('mutex serializes concurrent operations', async () => {
  const m = new Mutex();
  const order = [];
  const mk = (tag, ms) => async () => {
    order.push(`start:${tag}`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`end:${tag}`);
    return tag;
  };
  const [a, b, c] = await Promise.all([
    m.runExclusive(mk('a', 30)),
    m.runExclusive(mk('b', 5)),
    m.runExclusive(mk('c', 1)),
  ]);
  assert.deepEqual([a, b, c], ['a', 'b', 'c']);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
});

test('mutex releases on error', async () => {
  const m = new Mutex();
  await assert.rejects(m.runExclusive(async () => {
    throw new Error('boom');
  }));
  const v = await m.runExclusive(async () => 42);
  assert.equal(v, 42);
});
