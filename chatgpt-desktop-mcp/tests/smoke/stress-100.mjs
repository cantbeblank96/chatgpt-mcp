#!/usr/bin/env node
/**
 * Phase 1 acceptance stress test (design doc §16): 100 basic ask rounds.
 *
 * Acceptance metrics:
 *   - success rate >= 98%
 *   - duplicate sends == 0   (checked via AT-SPI '你说：' heading count per segment)
 *   - stale-reply mismatches == 0 (each reply must contain its unique token ok-<i>)
 *
 * Usage: node tests/smoke/stress-100.mjs [total=100] [segmentSize=10]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const mainJs = join(root, 'dist', 'main.js');
const auditPy = join(root, 'scripts', 'audit_conv.py');

const TOTAL = Number.parseInt(process.argv[2] ?? '100', 10);
const SEGMENT = Number.parseInt(process.argv[3] ?? '10', 10);
const START = Number.parseInt(process.argv[4] ?? '1', 10); // resume support

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(root, '..', 'artifacts', 'stress', stamp);
mkdirSync(outDir, { recursive: true });
const csvPath = join(outDir, 'results.csv');
appendFileSync(csvPath, 'round,segment,status,duration_ms,reply_len,error_code,token_ok\n');

// ---- prompt pool ---------------------------------------------------------
function makePrompt(i) {
  const token = `ok-${i}`;
  if (i % 25 === 0) {
    return { prompt: `请用不超过100字解释令牌 ${token} 的含义，并在最后一行单独输出 ${token}。`, kind: 'long', token };
  }
  if (i % 7 === 0) {
    return { prompt: `请先回复一行文字：${token}，然后再给一个只含 ${token} 的代码块。`, kind: 'code', token };
  }
  if (i % 5 === 0) {
    return { prompt: `请用Markdown回复一行，内容为粗体的 ${token}。`, kind: 'markdown', token };
  }
  if (i % 11 === 0) {
    return { prompt: `This is stress test round ${i}. Reply with exactly: ${token}`, kind: 'english', token };
  }
  return { prompt: `这是基础压测第 ${i} 轮，请只回复：${token}`, kind: 'short-zh', token };
}

// ---- MCP stdio client ----------------------------------------------------
const proc = spawn(process.execPath, [mainJs], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: proc.stdout });
let seq = 0;
const pending = new Map();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
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
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
function toolPayload(resp) {
  const item = resp.result?.content?.[0];
  if (!item) throw new Error('no content: ' + JSON.stringify(resp).slice(0, 300));
  return JSON.parse(item.text);
}

function auditConversation() {
  try {
    const out = execFileSync('/usr/bin/python3', [auditPy], { timeout: 30_000 }).toString().trim();
    return JSON.parse(out); // { user_count, last_user }
  } catch {
    return { user_count: NaN, last_user: '' };
  }
}

// ---- main ----------------------------------------------------------------
const stats = { ok: 0, fail: 0, tokenMiss: 0, dupSendViolations: 0, identityMisses: 0, rateLimited: 0, latencies: [] };
let consecutiveFail = 0;
let currentHandle = null;
let forceNewChat = false;      // recover after STALE/TIMEOUT by starting a fresh segment
let segRoundsSent = 0;         // user messages actually sent in the current segment
let lastPromptSent = '';       // for the structural (virtualization-safe) audit
let rateLimitPauses = 0;       // how many 10-min backoffs we have taken

// NOTE: the ChatGPT message list virtualizes (~14 items rendered), so the
// visible user_count plateaus on long conversations. Duplicate sends are
// therefore detected via count > expected, and message identity via the
// last-user-text check.
function auditSegment(label) {
  const a = auditConversation();
  const dup = a.user_count > segRoundsSent;
  if (dup) stats.dupSendViolations += (a.user_count - segRoundsSent);
  const identityOk = !lastPromptSent || (a.last_user || '').includes(lastPromptSent);
  if (!identityOk) stats.identityMisses += 1;
  console.log(`[stress] ${label} audit: user_msgs expected=${segRoundsSent} actual=${a.user_count} ${dup ? 'DUPLICATE-SEND!' : 'ok'} identity=${identityOk ? 'ok' : 'MISMATCH'}`);
}

try {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stress-100', version: '0.1.0' },
  });
  notify('notifications/initialized', {});
  console.log(`[stress] total=${TOTAL} segment=${SEGMENT} start=${START} out=${outDir}`);

  for (let i = START; i <= TOTAL; i++) {
    const segIdx = Math.floor((i - 1) / SEGMENT);
    const posInSeg = ((i - 1) % SEGMENT) + 1;
    let handle = null;

    if (i === START || posInSeg === 1 || forceNewChat) {
      if (forceNewChat && segRoundsSent > 0) {
        // audit the interrupted segment before abandoning it
        auditSegment('interrupted-segment');
      }
      forceNewChat = false;
      segRoundsSent = 0;
      const nc = toolPayload(await rpc('tools/call', {
        name: 'chatgpt_new_chat',
        arguments: { request_id: `stress-nc-${stamp}-${segIdx}-r${i}` },
      }, 90_000));
      if (!nc.ok) throw new Error(`new_chat failed at segment ${segIdx}: ${JSON.stringify(nc.error ?? nc)}`);
      handle = nc.conversation_handle;
      currentHandle = handle;
      console.log(`[stress] segment ${segIdx} started, handle=${handle}`);
    } else {
      handle = currentHandle;
    }

    const { prompt, kind, token } = makePrompt(i);
    const reqId = `stress-${stamp}-${i}`;
    const t0 = Date.now();
    let status = 'ok';
    let errorCode = '';
    let reply = '';
    try {
      const res = toolPayload(await rpc('tools/call', {
        name: 'chatgpt_ask',
        arguments: { prompt, conversation_handle: handle, request_id: reqId, timeout_ms: 240_000 },
      }, 320_000));
      const ms = Date.now() - t0;
      if (res.ok) {
        reply = res.text ?? '';
        stats.latencies.push(ms);
        if (!reply.toLowerCase().includes(token.toLowerCase())) {
          status = 'token_miss';
          stats.tokenMiss += 1;
        }
      } else {
        status = 'fail';
        errorCode = res.error?.code ?? 'UNKNOWN';
        if (errorCode === 'CONVERSATION_STALE' || errorCode === 'GENERATION_TIMEOUT'
            || errorCode === 'USER_INTERFERENCE_DETECTED') {
          forceNewChat = true; // recover: next round starts a fresh segment
        }
        if (errorCode === 'RATE_LIMITED' && rateLimitPauses < 3) {
          // external service constraint (HTTP 429): back off, then retry the
          // same round in a fresh segment. Not a pipeline failure.
          rateLimitPauses += 1;
          stats.rateLimited += 1;
          console.log(`[stress] RATE_LIMITED (${res.error?.details?.banner ?? ''}); pausing 600s before retry (pause ${rateLimitPauses}/3)`);
          await new Promise((r) => setTimeout(r, 600_000));
          forceNewChat = true;
          if (res.error?.details?.phase !== 'pre_send') {
            segRoundsSent += 1; // the prompt was committed before the 429 surfaced
            lastPromptSent = prompt;
          }
          consecutiveFail = 0;
          appendFileSync(csvPath, `${i},${segIdx},rate_limited_paused,${Date.now() - t0},0,,false\n`);
          continue; // retry same round i
        }
      }
    } catch (e) {
      status = 'fail';
      errorCode = 'CLIENT:' + String(e.message).slice(0, 60);
    }
    const ms = Date.now() - t0;

    if (status === 'ok') {
      stats.ok += 1; consecutiveFail = 0; segRoundsSent += 1; lastPromptSent = prompt;
      // gentle pacing keeps us under ChatGPT's rolling message-rate limit
      await new Promise((r) => setTimeout(r, 25_000));
    }
    else {
      stats.fail += 1;
      consecutiveFail += 1;
      // the prompt was still sent in most failure modes; count it for the audit
      if (errorCode !== 'CONVERSATION_STALE' && errorCode !== 'GENERATION_IN_PROGRESS') {
        segRoundsSent += 1;
        lastPromptSent = prompt;
      }
      writeFileSync(join(outDir, `fail-${i}.json`), JSON.stringify({ i, kind, prompt, status, errorCode, reply }, null, 1));
    }
    appendFileSync(csvPath, `${i},${segIdx},${status},${ms},${reply.length},${errorCode},${status === 'ok'}\n`);
    console.log(`[stress] #${i} (${kind}) ${status} ${ms}ms${errorCode ? ' code=' + errorCode : ''} replyLen=${reply.length}`);

    if (consecutiveFail >= 5) {
      console.log('[stress] ABORT: 5 consecutive failures — something systemic is wrong');
      break;
    }

    // segment boundary: duplicate-send audit (read-only AT-SPI)
    if (!forceNewChat && (posInSeg === SEGMENT || i === TOTAL)) {
      auditSegment(`segment ${segIdx}`);
    }
  }

  const done = stats.ok + stats.fail;
  const successRate = done ? (stats.ok / done) : 0;
  const lat = [...stats.latencies].sort((a, b) => a - b);
  const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0;
  const summary = {
    total_planned: TOTAL,
    rounds_executed: done,
    success: stats.ok,
    fail: stats.fail,
    rate_limited_pauses: stats.rateLimited,
    success_rate: Number(successRate.toFixed(4)),
    token_misses: stats.tokenMiss,
    duplicate_send_violations: stats.dupSendViolations,
    identity_mismatches: stats.identityMisses,
    latency_ms: { p50: pct(0.5), p90: pct(0.9), max: lat.at(-1) ?? 0 },
    acceptance: {
      'success_rate_ge_0.98': successRate >= 0.98,
      duplicate_sends_eq_0: stats.dupSendViolations === 0,
      stale_reply_eq_0: stats.tokenMiss === 0,
    },
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n[stress] SUMMARY:', JSON.stringify(summary, null, 1));
  proc.kill('SIGTERM');
  const pass = summary.acceptance['success_rate_ge_0.98']
    && summary.acceptance.duplicate_sends_eq_0
    && summary.acceptance.stale_reply_eq_0;
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('[stress] FATAL:', e.message);
  proc.kill('SIGTERM');
  process.exit(1);
}
