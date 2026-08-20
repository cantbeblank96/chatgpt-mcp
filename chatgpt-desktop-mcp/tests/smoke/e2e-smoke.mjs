#!/usr/bin/env node
/**
 * Phase 1 smoke test: drives the MCP server over stdio exactly like a
 * real MCP client (Claude Code / Cursor) would.
 *
 * Steps: initialize → tools/list → chatgpt_health → chatgpt_new_chat →
 *        chatgpt_ask → chatgpt_continue → idempotent replay of same request_id.
 *
 * Usage: node tests/smoke/e2e-smoke.mjs [prompt]
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

function summarize(payload) {
  if (payload?.ok) return `reply=${JSON.stringify((payload.text ?? '').slice(0, 80))}`;
  return `error=${JSON.stringify(payload?.error ?? payload).slice(0, 200)}`;
}

const results = {};
function report(name, pass, extra = '') {
  results[name] = pass ? 'PASS' : 'FAIL';
  console.log(`[smoke] ${name}: ${pass ? 'PASS' : 'FAIL'}${extra ? ' — ' + extra : ''}`);
}

try {
  // ---- handshake
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e-smoke', version: '0.1.0' },
  });
  console.log('[smoke] server:', init.result?.serverInfo?.name, init.result?.serverInfo?.version);
  notify('notifications/initialized', {});

  const list = await rpc('tools/list', {});
  const tools = (list.result?.tools ?? []).map((t) => t.name);
  report('tools/list', ['chatgpt_health', 'chatgpt_new_chat', 'chatgpt_ask', 'chatgpt_continue', 'chatgpt_cancel', 'chatgpt_list_conversations'].every((t) => tools.includes(t)), tools.join(','));

  // ---- health
  const health = toolText(await rpc('tools/call', { name: 'chatgpt_health', arguments: {} }));
  report('chatgpt_health', health.ok === true, JSON.stringify({ mode: health.mode, composer: health.composerFound }));

  // ---- new chat
  const nc = toolText(await rpc('tools/call', { name: 'chatgpt_new_chat', arguments: { request_id: `smoke-nc-${Date.now()}` } }, 60_000));
  report('chatgpt_new_chat', nc.ok === true && /^cgpt_[a-f0-9]{16}$/.test(nc.conversation_handle ?? ''), nc.ok ? nc.conversation_handle : JSON.stringify(nc.error ?? nc).slice(0, 200));
  const handle = nc.conversation_handle;

  // ---- ask
  const prompt = process.argv[2] ?? '这是 MCP 端到端自动化测试，请只回复：e2e-ok';
  const reqId = `smoke-ask-${Date.now()}`;
  const t0 = Date.now();
  const ask = toolText(await rpc('tools/call', {
    name: 'chatgpt_ask',
    arguments: { prompt, conversation_handle: handle, request_id: reqId },
  }, 300_000));
  const askMs = Date.now() - t0;
  report('chatgpt_ask', ask.ok === true && ask.text?.length > 0 && ask.conversation_handle === handle,
    `${summarize(ask)} in ${askMs}ms via adapter=${ask.adapter ?? '?'}`);

  // ---- continue in same conversation
  const t1 = Date.now();
  const cont = toolText(await rpc('tools/call', {
    name: 'chatgpt_continue',
    arguments: {
      prompt: '这是同一会话的第二轮测试，请只回复：continue-ok',
      conversation_handle: handle,
      request_id: `smoke-cont-${Date.now()}`,
    },
  }, 300_000));
  report('chatgpt_continue', cont.ok === true && cont.text?.length > 0,
    `${summarize(cont)} in ${Date.now() - t1}ms`);

  // ---- idempotent replay: same request_id must NOT re-send
  const replay = toolText(await rpc('tools/call', {
    name: 'chatgpt_ask',
    arguments: { prompt, conversation_handle: handle, request_id: reqId },
  }, 60_000));
  report('idempotent_replay', replay.ok === true && replay.replayed === true && replay.text === ask.text,
    `replayed=${replay.replayed ?? false}`);

  // ---- Phase 3: read-only sidebar enumeration
  const lc = toolText(await rpc('tools/call', { name: 'chatgpt_list_conversations', arguments: { limit: 10 } }, 60_000));
  report('chatgpt_list_conversations', lc.ok === true && Array.isArray(lc.conversations) && lc.count > 0,
    `count=${lc.count ?? 0} first=${JSON.stringify((lc.conversations ?? [])[0] ?? null)}`);

  // ---- Phase 3: cancel while idle must be a safe no-op
  const cx = toolText(await rpc('tools/call', { name: 'chatgpt_cancel', arguments: {} }, 60_000));
  report('chatgpt_cancel_idle', cx.ok === true && cx.cancelled === false, `cancelled=${cx.cancelled}`);

  const failed = Object.entries(results).filter(([, v]) => v !== 'PASS');
  console.log('\n[smoke] SUMMARY:', JSON.stringify(results, null, 1));
  proc.kill('SIGTERM');
  process.exit(failed.length === 0 ? 0 : 1);
} catch (e) {
  console.error('[smoke] FATAL:', e.message);
  console.log('[smoke] SUMMARY so far:', JSON.stringify(results));
  proc.kill('SIGTERM');
  process.exit(1);
}
