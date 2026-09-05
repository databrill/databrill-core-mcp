/**
 * MCP stdio frontend (P1 / Desktop / dev). Runs under bun and deno:
 *   bun run bin/stdio.ts        deno run -A bin/stdio.ts
 *
 * Connection resolution: DATABRILL_CONFIG maps each call's required `wsid` to
 * that workspace's own credential, with per-workspace pooling.
 * Pools are lazy (opened on first use) and closed on shutdown.
 */

import "temporal-polyfill/global";
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../src/config.ts";
import { createSqlProvider } from "../src/db.ts";
import { registerTools } from "../src/registerTools.ts";

const config = loadConfig();
if (config === null) {
	throw new Error("DATABRILL_CONFIG is required; unscoped POSTGRES_URL mode is not supported");
}
const provider = createSqlProvider(config);

const server = new Server(
	{ name: "databrill-core-mcp", version: "0.2.3" },
	{ capabilities: { tools: {} } },
);
// One connection per workspace, so the tool's access kind changes nothing here.
registerTools(server, (args, _access) => provider.getSqlForArgs(args), config);

await server.connect(new StdioServerTransport());

const shutdown = async () => {
	await provider.endAll();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
