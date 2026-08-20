/**
 * MCP tool registration. This layer only maps MCP arguments onto the
 * Orchestrator and serializes structured results/errors — it never touches
 * AT-SPI roles, window titles, keyboard or mouse (design doc §7).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Orchestrator } from '../core/orchestrator.js';
import { AdapterError, toAdapterError } from '../core/errors.js';
import { AskInputSchema, ContinueInputSchema, HealthInputSchema, NewChatInputSchema, CancelInputSchema, ListConversationsInputSchema } from './schemas.js';

type ToolReturn = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(payload: unknown): ToolReturn {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(e: unknown): ToolReturn {
  const err = toAdapterError(e);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.toJSON() }, null, 2) }],
  };
}

export function registerTools(server: McpServer, orch: Orchestrator): void {
  server.registerTool(
    'chatgpt_health',
    {
      title: 'ChatGPT Desktop health',
      description:
        'Check that the local ChatGPT Desktop app is running, its accessibility surface is reachable, ' +
        'the plain Chat mode is active and the composer is available. Read-only.',
      inputSchema: HealthInputSchema,
    },
    async () => {
      try {
        const h = await orch.health();
        return ok({ ok: true, adapter: 'atspi', ...h });
      } catch (e) {
        if (e instanceof AdapterError) {
          return ok({ ok: false, adapter: 'atspi', error: e.toJSON() });
        }
        return fail(e);
      }
    },
  );

  server.registerTool(
    'chatgpt_new_chat',
    {
      title: 'ChatGPT new chat',
      description:
        'Open a new conversation in the local ChatGPT Desktop (plain Chat mode) and return its ' +
        'conversation_handle for later chatgpt_ask / chatgpt_continue calls.',
      inputSchema: NewChatInputSchema,
    },
    async ({ request_id }: { request_id?: string }) => {
      try {
        const r = await orch.newChat(request_id);
        return ok({ ok: true, adapter: 'atspi', ...r });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'chatgpt_ask',
    {
      title: 'ChatGPT ask',
      description:
        'Send a prompt to the local ChatGPT Desktop (plain Chat mode) and wait for the final assistant ' +
        'reply. Completion is detected via new-message + generation-inactive + text-stability signals, ' +
        'never a fixed sleep. Provide request_id for idempotency; a repeated request_id is never re-sent.',
      inputSchema: AskInputSchema,
    },
    async (args: {
      prompt: string;
      conversation_handle?: string;
      new_chat?: boolean;
      mode?: 'auto';
      timeout_ms?: number;
      request_id?: string;
    }) => {
      try {
        const result = await orch.ask({
          prompt: args.prompt,
          conversationHandle: args.conversation_handle,
          newChat: args.new_chat,
          mode: args.mode,
          timeoutMs: args.timeout_ms,
          requestId: args.request_id,
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'chatgpt_continue',
    {
      title: 'ChatGPT continue conversation',
      description:
        'Send a follow-up prompt in an existing MCP-managed conversation. Fails with CONVERSATION_STALE ' +
        'if the visible ChatGPT conversation no longer matches the handle (e.g. the user switched chats).',
      inputSchema: ContinueInputSchema,
    },
    async (args: { prompt: string; conversation_handle: string; timeout_ms?: number; request_id?: string }) => {
      try {
        const result = await orch.ask({
          prompt: args.prompt,
          conversationHandle: args.conversation_handle,
          newChat: false,
          timeoutMs: args.timeout_ms,
          requestId: args.request_id,
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'chatgpt_cancel',
    {
      title: 'ChatGPT cancel generation',
      description:
        'Press Stop on an in-flight ChatGPT Desktop generation. Returns cancelled=false when no ' +
        'generation is running (no-op). Safe to call at any time; never sends a prompt.',
      inputSchema: CancelInputSchema,
    },
    async () => {
      try {
        const r = await orch.cancel();
        return ok({ ok: true, adapter: 'atspi', ...r });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'chatgpt_list_conversations',
    {
      title: 'ChatGPT list conversations',
      description:
        'Read-only: enumerate the visible sidebar conversation titles (recent list). The sidebar ' +
        'virtualizes, so only rendered rows are returned. Does not switch conversations.',
      inputSchema: ListConversationsInputSchema,
    },
    async ({ limit }: { limit?: number }) => {
      try {
        const r = await orch.listConversations(limit);
        return ok({ ok: true, adapter: 'atspi', ...r });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
