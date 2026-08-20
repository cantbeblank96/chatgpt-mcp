/**
 * MCP tool input/output schemas (design doc §8.2).
 */
import { z } from 'zod';

export const HealthInputSchema = {};

export const NewChatInputSchema = {
  request_id: z
    .string()
    .max(128)
    .optional()
    .describe('Caller-provided idempotency key; retries with the same key never create a second chat.'),
};

export const AskInputSchema = {
  prompt: z.string().min(1).max(200_000).describe('The prompt to send to ChatGPT (plain Chat mode).'),
  conversation_handle: z
    .string()
    .regex(/^cgpt_[a-f0-9]{16}$/)
    .optional()
    .describe('Continue this MCP-managed conversation. Omit (or set new_chat=true) to start a new chat.'),
  new_chat: z.boolean().optional().default(false).describe('Force a new conversation before sending.'),
  mode: z.enum(['auto']).optional().default('auto').describe('Only "auto" is supported: plain Chat surface.'),
  timeout_ms: z.number().int().min(10_000).max(1_800_000).optional().describe('Max wait for the reply (default 180000).'),
  request_id: z
    .string()
    .max(128)
    .optional()
    .describe('Idempotency key. NEVER reuse it for a different prompt; a repeated key is never re-sent.'),
};

export const ContinueInputSchema = {
  prompt: z.string().min(1).max(200_000),
  conversation_handle: z
    .string()
    .regex(/^cgpt_[a-f0-9]{16}$/)
    .describe('The conversation to continue (from a previous chatgpt_ask / chatgpt_new_chat).'),
  timeout_ms: z.number().int().min(10_000).max(1_800_000).optional(),
  request_id: z.string().max(128).optional(),
};

export const CancelInputSchema = {};

export const ListConversationsInputSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Max titles to return (default 50). The sidebar virtualizes; only rendered rows are visible.'),
};
