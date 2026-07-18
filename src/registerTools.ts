/**
 * Mount every tool from the contract onto an MCP `Server`. This is the library
 * entry point: the stdio frontend (bin/stdio.ts) and the hosted frontend (P2,
 * in a separate repo) both call this — they differ only in how `getSql`
 * resolves the connection (POSTGRES_URL vs OAuth→wsid→pooled target DB).
 *
 * When a multi-workspace `Config` is passed, each tool gains an optional `wsid`
 * argument (enum of the configured workspaces) and a `listWorkspaces` discovery
 * tool is exposed. `getSql` receives the call's arguments so it can route to the
 * right workspace connection.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	type CallToolRequest,
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Sql } from "postgres";
import { type Config, summarizeConfig } from "./config.ts";
import { tools } from "./contract.ts";

const LIST_WORKSPACES = "listWorkspaces";

/** Add an optional `wsid` enum property to a tool's input schema (non-destructively). */
function withWsid(inputSchema: Record<string, unknown>, wsids: string[]): Record<string, unknown> {
	const properties = { ...(inputSchema.properties as Record<string, unknown> | undefined) };
	properties.wsid = {
		type: "string",
		enum: wsids,
		description:
			"Workspace id (wsid). Required only when the requested store(s) exist in more than one workspace; " +
			"otherwise the workspace is inferred. Call listWorkspaces to see the options.",
	};
	return { ...inputSchema, properties };
}

export function registerTools(
	server: Server,
	getSql: (args: Record<string, unknown>) => Sql,
	config?: Config | null,
): void {
	const wsids = config ? Object.keys(config.workspaces) : [];
	const multiWorkspace = wsids.length > 1;

	server.setRequestHandler(ListToolsRequestSchema, () => {
		const listed = tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: multiWorkspace ? withWsid(t.inputSchema, wsids) : t.inputSchema,
		}));
		if (config) {
			listed.unshift({
				name: LIST_WORKSPACES,
				description:
					"List the configured client workspaces (wsid, label, merchants and the countries each sells in). " +
					"Use it to pick a `wsid` when a country is served by more than one workspace.",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
			});
		}
		return { tools: listed };
	});

	server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
		const args = (req.params.arguments ?? {}) as Record<string, unknown>;

		if (config && req.params.name === LIST_WORKSPACES) {
			return { content: [{ type: "text", text: JSON.stringify(summarizeConfig(config), null, 2) }] };
		}

		const tool = tools.find((t) => t.name === req.params.name);
		if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
		try {
			const result = await tool.run(args, getSql(args));
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
		}
	});
}
