#!/usr/bin/env node
/**
 * chatgpt-desktop-mcp entrypoint.
 *
 *   chatgpt-desktop-mcp          → MCP server over stdio (default)
 *   chatgpt-desktop-mcp probe    → one-shot capability probe, JSON on stdout
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config/index.js';
import { configureLogging, logger } from './logging/logger.js';
import { createMcpServer } from './mcp/server.js';
import { AtspiAdapter } from './adapters/atspi/adapter.js';
import { SidecarClient } from './adapters/atspi/sidecar-client.js';

const here = dirname(fileURLToPath(import.meta.url));

function resolveWorkerScript(configured: string | null): string {
  const candidates = configured
    ? [configured]
    : [
        join(here, 'adapters', 'atspi', 'python', 'atspi_worker.py'), // dist layout
        join(here, '..', 'src', 'adapters', 'atspi', 'python', 'atspi_worker.py'), // repo layout
      ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`atspi_worker.py not found; tried: ${candidates.join(', ')}`);
}

async function runProbe(): Promise<number> {
  const config = loadConfig();
  configureLogging(config);
  const workerScript = resolveWorkerScript(config.workerScript);
  const sidecar = new SidecarClient(config.pythonPath, workerScript, config.sidecarCallTimeoutMs);
  const adapter = new AtspiAdapter(sidecar);
  try {
    const result = await adapter.probe();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? 0 : 1;
  } catch (e) {
    process.stdout.write(JSON.stringify({ adapter: 'atspi', ok: false, checks: {}, problems: [String(e)], hints: [] }, null, 2) + '\n');
    return 1;
  } finally {
    adapter.dispose();
  }
}

async function runServer(): Promise<void> {
  const config = loadConfig();
  configureLogging(config);
  const workerScript = resolveWorkerScript(config.workerScript);
  const bundle = createMcpServer(config, workerScript);
  const transport = new StdioServerTransport();
  await bundle.server.connect(transport);
  logger.info('chatgpt-desktop-mcp ready', {
    adapter: 'atspi',
    worker: workerScript,
    compliance_mode: config.complianceMode,
  });

  const shutdown = () => {
    logger.info('shutting down');
    bundle.dispose();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const cmd = process.argv[2];
if (cmd === 'probe') {
  runProbe().then((code) => process.exit(code));
} else {
  runServer().catch((e) => {
    logger.error('fatal', { err: String(e?.stack ?? e) });
    process.exit(1);
  });
}
