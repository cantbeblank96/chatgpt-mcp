#!/usr/bin/env node
/**
 * Phase 3 chaos / injection smoke: verifies interrupt & recovery paths
 * against the REAL GUI (design doc §15.1).
 *
 *  A. chatgpt_cancel interrupts an in-flight generation (cancel is NOT
 *     serialized behind the ask mutex, so it reaches the GUI).
 *  B. GENERATION_TIMEOUT releases the global mutex; a follow-up ask works
 *     after the GUI generation is stopped.
 *
 * Usage: node tests/smoke/e2e-chaos.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const mainJs = join(here, '..', '..', 'dist', 'main.js');

const proc = spawn(process.execPath, [mainJs], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: proc.stdout });

let seq = 0;
const pending = new Map();

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }
});

function rpc(method, params, timeoutMs = 60_000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function toolText(resp) {
  const item = resp.result?.content?.[0];
  if (!item) throw new Error('no content: ' + JSON.stringify(resp));
  return JSON.parse(item.text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
function report(name, pass, extra = '') {
  results[name] = pass ? 'PASS' : 'FAIL';
  console.log(`[chaos] ${name}: ${pass ? 'PASS' : 'FAIL'}${extra ? ' — ' + extra : ''}`);
}

async function callTool(name, args, timeoutMs) {
  return toolText(await rpc('tools/call', { name, arguments: args }, timeoutMs));
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e-chaos', version: '0.1.0' },
  });
  console.log('[chaos] server:', init.result?.serverInfo?.name);
  notify('notifications/initialized', {});

  // ================= A. cancel interrupts an in-flight generation =================
  const ncA = await callTool('chatgpt_new_chat', { request_id: `chaos-ncA-${Date.now()}` });
  const handleA = ncA.conversation_handle;

  const longPrompt = '请写一篇不少于一万字的、关于中国古代建筑史的超长文章，务必详尽。';
  const askPromise = callTool('chatgpt_ask', {
    prompt: longPrompt,
    conversation_handle: handleA,
    request_id: `chaos-askA-${Date.now()}`,
    timeout_ms: 120_000,
  }, 200_000);

  // let the generation actually start and stream some tokens
  await sleep(9_000);
  const cancelA = await callTool('chatgpt_cancel', {}, 60_000);
  report('cancel_during_generation', cancelA.ok === true && cancelA.cancelled === true,
    `cancelled=${cancelA.cancelled}`);

  const tA = Date.now();
  const askA = await askPromise; // must resolve promptly after Stop, not hang
  const resolvedFast = Date.now() - tA < 60_000;
  report('ask_resolves_after_cancel', resolvedFast,
    `ok=${askA.ok === true} err=${askA.error?.code ?? 'none'} in ${Date.now() - tA}ms after cancel`);

  await sleep(2_000);

  // ================= B. generation timeout releases the mutex =================
  const ncB = await callTool('chatgpt_new_chat', { request_id: `chaos-ncB-${Date.now()}` });
  const handleB = ncB.conversation_handle;

  const timed = await callTool('chatgpt_ask', {
    prompt: '请写一篇不少于八千字的、关于海洋生态的长文，越详细越好。',
    conversation_handle: handleB,
    request_id: `chaos-askB-${Date.now()}`,
    timeout_ms: 10_000, // force GENERATION_TIMEOUT
  }, 60_000);
  report('generation_timeout_structured', timed.ok === false && timed.error?.code === 'GENERATION_TIMEOUT',
    `code=${timed.error?.code ?? 'ok'}`);

  // stop the still-running GUI generation so the surface is reusable
  await callTool('chatgpt_cancel', {}, 60_000);
  await sleep(3_000);

  // mutex must be free now: a button-only new_chat (no paste) should complete.
  // This proves recovery without depending on the clipboard/paste channel.
  const follow = await callTool('chatgpt_new_chat', { request_id: `chaos-follow-${Date.now()}` }, 60_000);
  report('mutex_released_after_timeout', follow.ok === true && /^cgpt_[a-f0-9]{16}$/.test(follow.conversation_handle ?? ''),
    `ok=${follow.ok === true} handle=${follow.conversation_handle ?? follow.error?.code ?? ''}`);

  const failed = Object.entries(results).filter(([, v]) => v !== 'PASS');
  console.log('\n[chaos] SUMMARY:', JSON.stringify(results, null, 1));
  proc.kill('SIGTERM');
  process.exit(failed.length === 0 ? 0 : 1);
} catch (e) {
  console.error('[chaos] FATAL:', e.message);
  console.log('[chaos] SUMMARY so far:', JSON.stringify(results));
  proc.kill('SIGTERM');
  process.exit(1);
}
