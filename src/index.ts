#!/usr/bin/env node
// stdio entry point. stdout carries the MCP protocol, so logs go to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { AmpSession } from "./session.js";

const session = new AmpSession();
const server = createServer(session);
await server.connect(new StdioServerTransport());
console.error("ltamp-mcp: ready");

const shutdown = async () => {
  await session.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
