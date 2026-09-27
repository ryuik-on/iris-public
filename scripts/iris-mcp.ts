#!/usr/bin/env -S npx tsx
/**
 * The stdio entry point, so a CLI can start IRIS as an MCP server.
 *
 * Deliberately thin. Everything that decides anything is in
 * `server/core/mcp_server.ts`, which takes its world as an argument and is
 * tested without a socket; this file is the transport and the two pieces of IO
 * that touch the machine.
 *
 * Register it with:
 *
 *   claude mcp add iris -- npx tsx ~/Projects/iris/scripts/iris-mcp.ts
 *   codex mcp add iris -- npx tsx ~/Projects/iris/scripts/iris-mcp.ts
 *
 * Nothing is written to stdout except the protocol. A stray `console.log` here
 * corrupts the stream and the client reports the server as broken, so
 * diagnostics go to stderr.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { IRIS_TOOLS, callIrisTool, IrisIo } from '../server/core/mcp_server.js';

const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:3002';
const OFFLINE = join(homedir(), '.iris', 'briefing.json');

/**
 * A short timeout, because a blocked socket must fail rather than hang.
 *
 * Inside Codex's sandbox a request to 127.0.0.1 does not get refused quickly —
 * it is the fallback path that matters, and a tool call that sits for thirty
 * seconds before taking it is indistinguishable from a hung server.
 */
const TIMEOUT_MS = 4000;

const io: IrisIo = {
  async request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Read the body whatever the status: IRIS puts the reason a write was
    // refused in the body, and that reason is the useful part.
    let json: any = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  },
  async offlineBriefing() {
    try {
      return { json: JSON.parse(await readFile(OFFLINE, 'utf8')), path: OFFLINE };
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
};

const server = new Server(
  { name: 'iris', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: IRIS_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { text, isError } = await callIrisTool(request.params.name, request.params.arguments, io);
  return { content: [{ type: 'text', text }], isError };
});

// The project compiles to CommonJS, where top-level await is not available,
// so the connect lives in a function rather than at the file's edge.
async function main() {
  await server.connect(new StdioServerTransport());
  process.stderr.write(`iris mcp server ready (${BASE})\n`);
}

main().catch((err) => {
  // stderr, never stdout: stdout carries the protocol.
  process.stderr.write(`iris mcp server failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
