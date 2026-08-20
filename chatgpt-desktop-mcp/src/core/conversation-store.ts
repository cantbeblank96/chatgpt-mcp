/**
 * Conversation store: MCP-owned conversation_handle (cgpt_*).
 * We never expose ChatGPT-internal ids as API contract (design doc §8.3).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { AdapterError } from './errors.js';
import { logger } from '../logging/logger.js';

export interface ConversationRecord {
  handle: string;
  createdAt: string;
  updatedAt: string;
  /** fingerprint of the message list TAIL at last successful turn */
  lastFingerprint?: string;
  /** normalized text of the last user prompt we sent (structural anchor;
   * survives message-list virtualization unlike full-list fingerprints) */
  lastUserPrompt?: string;
  lastUserCount?: number;
  lastAssistantCount?: number;
  turnCount: number;
}

const MAX_RECORDS = 200;

export class ConversationStore {
  private file: string;
  private records = new Map<string, ConversationRecord>();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.file = join(stateDir, 'conversations.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const arr = JSON.parse(readFileSync(this.file, 'utf8')) as ConversationRecord[];
      for (const r of arr.slice(-MAX_RECORDS)) this.records.set(r.handle, r);
    } catch (e) {
      logger.warn('conversation store unreadable, starting fresh', { err: String(e) });
    }
  }

  private persist(): void {
    try {
      const arr = [...this.records.values()].slice(-MAX_RECORDS);
      writeFileSync(this.file, JSON.stringify(arr, null, 1), { mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch (e) {
      logger.warn('conversation store persist failed', { err: String(e) });
    }
  }

  create(): ConversationRecord {
    const now = new Date().toISOString();
    const rec: ConversationRecord = {
      handle: `cgpt_${randomBytes(8).toString('hex')}`,
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
    };
    this.records.set(rec.handle, rec);
    this.persist();
    return rec;
  }

  get(handle: string): ConversationRecord {
    const rec = this.records.get(handle);
    if (!rec) {
      throw new AdapterError('CONVERSATION_NOT_FOUND', `unknown conversation_handle: ${handle}`);
    }
    return rec;
  }

  update(handle: string, patch: Partial<ConversationRecord>): ConversationRecord {
    const rec = this.get(handle);
    Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    return rec;
  }
}
