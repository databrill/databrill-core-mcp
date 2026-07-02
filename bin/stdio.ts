/**
 * MCP stdio frontend (P1 / Desktop / dev). Runs under bun and deno:
 *   bun run bin/stdio.ts        deno run -A bin/stdio.ts
 *
 * Connection resolution:
 *   • DATABRILL_CONFIG set → multi-workspace: each call routes to a workspace
 *     (by `wsid`, or inferred from the stores) with per-workspace pooling.
 *   • otherwise            → single POSTGRES_URL pool (the client's own DB).
 * Pools are lazy (opened on first use) and closed on shutdown.
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../src/config.ts";
import { createSqlProvider } from "../src/db.ts";
import { registerTools } from "../src/registerTools.ts";

const config = loadConfig();
const provider = createSqlProvider(config);

const server = new Server(
	{ name: "databrill-core-mcp", version: "0.1.0" },
	{ capabilities: { tools: {} } },
);
registerTools(server, (args) => provider.getSqlForArgs(args), config);

await server.connect(new StdioServerTransport());

const shutdown = async () => {
	await provider.endAll();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
