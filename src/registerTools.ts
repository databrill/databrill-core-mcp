/**
 * Mount every tool from the contract onto an MCP `Server`. This is the library
 * entry point: the stdio frontend (bin/stdio.ts) and the hosted frontend both
 * call this — they differ only in how `getSql` resolves the connection
 * (POSTGRES_URL vs OAuth→wsid→pooled target DB).
 *
 * When a multi-workspace `WorkspaceDirectory` is passed, each tool gains an optional `wsid`
 * argument (enum of the configured workspaces) and a `listWorkspaces` discovery
 * tool is exposed. `getSql` receives the call's arguments so it can route to the
 * right workspace connection, PLUS the calling tool's declared `access` kind so it
 * can route a write tool to a different connection than a read tool. Arguments alone
 * cannot express that, and deciding it by tool NAME outside this seam is exactly what
 * the declared access kind exists to prevent. Frontends with one connection ignore the
 * parameter. The directory carries no `database` field, so its keys and
 * `wsids`/`multiWorkspace` are recomputed on every `tools/list` call rather than
 * cached at registration time — a hosted session's workspace set can change mid-session.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	type CallToolRequest,
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Sql } from "postgres";
import {
	resolveWorkspace,
	SQL_FEATURE,
	SQL_WRITE_FEATURE,
	summarizeConfig,
	type WorkspaceDirectory,
	type WorkspaceFeatures,
	workspaceHasFeature,
} from "./config.ts";
import { tools } from "./contract.ts";
import type { McpTool, McpToolAccess } from "./contract.ts";
import type { McpToolHooks } from "./toolHooks.ts";

export type { McpToolAccess } from "./contract.ts";
export type { McpToolHooks } from "./toolHooks.ts";

const LIST_WORKSPACES = "listWorkspaces";

/** What a binding frontend needs to know about a tool BEFORE it dispatches the call. */
export interface McpToolInfo {
	readonly access: McpToolAccess;
	/** True for the general SQL surface — the tools gated by `sql` or `sqlWrite`. */
	readonly isSql: boolean;
}

/**
 * Tool name → its access kind and whether it belongs to the SQL surface, derived
 * from the SAME `tools` array `registerTools` iterates, so the two can never
 * disagree.
 *
 * Exported from THIS module rather than `contract.ts` on purpose: the hosted app's
 * boundary scan pins the set of mcp-local modules `apps/mcp` may import to exactly
 * `config.ts` and `registerTools.ts`, and the hosted planner needs each planned
 * call's access kind before dispatch. Frozen so a consumer cannot mutate the
 * registry's own view of itself.
 */
export const toolInfoByName: Readonly<Record<string, McpToolInfo>> = Object.freeze(
	Object.fromEntries(
		tools.map((tool) => [
			tool.name,
			Object.freeze({
				access: tool.access ?? "read",
				isSql: isSqlTool(tool),
			}),
		]),
	),
);

/** Whether a tool belongs to the general SQL surface, from its DECLARED feature flag. */
function isSqlTool(tool: McpTool): boolean {
	return tool.feature === SQL_FEATURE || tool.feature === SQL_WRITE_FEATURE;
}

export interface RegisterToolsOptions {
	/** Feature flags for a fixed single-workspace frontend with no directory. */
	readonly fixedFeatures?: WorkspaceFeatures;
	/**
	 * Per-call hooks, resolved from the same inputs as `getSql`. Frontends with a
	 * single connection omit it and every hook is a no-op.
	 */
	readonly getHooks?: (args: Record<string, unknown>, access: McpToolAccess) => McpToolHooks;
}

/** Add an optional `wsid` enum property to a tool's input schema (non-destructively). */
function withWsid(
	inputSchema: Record<string, unknown>,
	wsids: string[],
	alwaysRequired: boolean,
): Record<string, unknown> {
	const properties = { ...(inputSchema["properties"] as Record<string, unknown> | undefined) };
	properties["wsid"] = {
		type: "string",
		enum: wsids,
		description: alwaysRequired
			? "Workspace id (wsid). Required on every call to this tool. Call listWorkspaces to see the options."
			: "Workspace id (wsid). Required only when the requested store(s) exist in more than one workspace; " +
				"otherwise the workspace is inferred. Call listWorkspaces to see the options.",
	};
	const schema: Record<string, unknown> = { ...inputSchema, properties };
	if (alwaysRequired) {
		const raw = inputSchema["required"];
		const required: unknown[] = Array.isArray(raw) ? [...raw] : [];
		schema["required"] = required.includes("wsid") ? required : [...required, "wsid"];
	}
	return schema;
}

/**
 * Whether a tool must advertise `wsid` even in a single-workspace directory.
 *
 * The general SQL tools do. A binding frontend may refuse a SQL call that names no
 * workspace — rather than inferring one — so that no caller-authored SQL is ever
 * routed implicitly and every such call names its workspace in the audit trail.
 * Advertising the property only when several workspaces exist would leave a
 * schema-following agent unable to satisfy that rule on a one-workspace session: the
 * tools declare `additionalProperties: false`, so `wsid` would not appear anywhere in
 * the contract it can see, while the call is refused for omitting it.
 */
function requiresExplicitWsid(tool: McpTool): boolean {
	return isSqlTool(tool);
}

function eligibleWsids(tool: McpTool, config: WorkspaceDirectory): string[] {
	if (tool.feature === undefined) {
		return Object.keys(config.workspaces);
	}
	return Object.values(config.workspaces)
		.filter((workspace) => workspaceHasFeature(workspace, tool.feature ?? ""))
		.map((workspace) => workspace.wsid);
}

function isVisible(
	tool: McpTool,
	config: WorkspaceDirectory | null | undefined,
	options: RegisterToolsOptions,
): boolean {
	if (tool.feature === undefined) {
		return true;
	}
	if (config === null || config === undefined) {
		return options.fixedFeatures?.[tool.feature] === true;
	}
	return eligibleWsids(tool, config).length > 0;
}

function isAllowedForCall(
	tool: McpTool,
	args: Record<string, unknown>,
	config: WorkspaceDirectory | null | undefined,
	options: RegisterToolsOptions,
): boolean {
	if (!isVisible(tool, config, options)) {
		return false;
	}
	if (tool.feature === undefined || config === null || config === undefined) {
		return true;
	}
	try {
		return workspaceHasFeature(resolveWorkspace(config, args), tool.feature);
	} catch {
		// Let the connection resolver produce its existing actionable ambiguity
		// error. The tool is visible because at least one workspace supports it.
		return true;
	}
}

export function registerTools(
	server: Server,
	getSql: (args: Record<string, unknown>, access: McpToolAccess) => Sql,
	config?: WorkspaceDirectory | null,
	options: RegisterToolsOptions = {},
): void {
	server.setRequestHandler(ListToolsRequestSchema, () => {
		const wsids = config ? Object.keys(config.workspaces) : [];
		const multiWorkspace = wsids.length > 1;

		const listed = tools.filter((tool) => isVisible(tool, config, options)).map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: config && (multiWorkspace || requiresExplicitWsid(tool))
				? withWsid(tool.inputSchema, eligibleWsids(tool, config), requiresExplicitWsid(tool))
				: tool.inputSchema,
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
		if (!tool || !isAllowedForCall(tool, args, config, options)) {
			throw new Error(`Unknown tool: ${req.params.name}`);
		}
		try {
			const access = tool.access ?? "read";
			const result = await tool.run(args, getSql(args, access), options.getHooks?.(args, access));
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
		}
	});
}
