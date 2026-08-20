/**
 * MCP server assembly: wires config → sidecar → adapter → orchestrator → tools.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig } from '../config/index.js';
import { AtspiAdapter } from '../adapters/atspi/adapter.js';
import { SidecarClient } from '../adapters/atspi/sidecar-client.js';
import { ConversationStore } from '../core/conversation-store.js';
import { Mutex } from '../core/mutex.js';
import { OperationStore } from '../core/operation-store.js';
import { Orchestrator } from '../core/orchestrator.js';
import { registerTools } from './tools.js';

export interface ServerBundle {
  server: McpServer;
  orchestrator: Orchestrator;
  dispose: () => void;
}

export function createMcpServer(config: AppConfig, workerScript: string): ServerBundle {
  const sidecar = new SidecarClient(config.pythonPath, workerScript, config.sidecarCallTimeoutMs);
  const adapter = new AtspiAdapter(sidecar);
  const orchestrator = new Orchestrator({
    adapter,
    mutex: new Mutex(),
    ops: new OperationStore(config.stateDir),
    conversations: new ConversationStore(config.stateDir),
    askTimeoutMs: config.askTimeoutMs,
    stabilizationMs: config.stabilizationMs,
    pollIntervalMs: config.pollIntervalMs,
  });

  const server = new McpServer({
    name: 'chatgpt-desktop-mcp',
    version: '0.1.0',
  });
  registerTools(server, orchestrator);

  return {
    server,
    orchestrator,
    dispose: () => adapter.dispose(),
  };
}
