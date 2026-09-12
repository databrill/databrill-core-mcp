/**
 * Mount every tool from the contract onto an MCP `Server`. This is the library
 * entry point: the stdio frontend (bin/stdio.ts) and the hosted frontend both
 * call this — they differ only in how `getSql` resolves the connection
 * (registry-selected local credential vs OAuth→wsid→pooled target DB).
 *
 * When a `WorkspaceDirectory` is passed, each data tool gains a required `wsid`
 * argument (enum of the configured workspaces) and a `listWorkspaces` discovery
 * tool is exposed. `getSql` receives the call's arguments so it can route to the
 * right workspace connection, PLUS the calling tool's declared `access` kind so it
 * can route a write tool to a different connection than a read tool. Arguments alone
 * cannot express that, and deciding it by tool NAME outside `registerTools` is exactly what
 * the declared access kind exists to prevent. Frontends with one connection ignore the
 * parameter. The directory carries no `database` field, so its keys and
 * `wsids`/`multiWorkspace` are recomputed on every `tools/list` call rather than
 * cached at registration time — a hosted session's workspace set can change mid-session.
 * A workspace-scoped frontend can instead pass `options.discoveryDirectory` with
 * no routing directory to expose `listWorkspaces` without a `wsid` tool argument.
 */

import { Effect, Either } from "effect";
import { exitValue, tryOrOperationError } from "./effectErrors.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	type CallToolRequest,
	CallToolRequestSchema,
	type CallToolResult,
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
import { encodeToolResult } from "./sqlGuardrails.ts";
import type { McpToolHooks } from "./toolHooks.ts";

export type { McpToolAccess } from "./contract.ts";
export type { McpToolHooks } from "./toolHooks.ts";

const LIST_WORKSPACES = "listWorkspaces";

/** What a binding frontend needs to know about a tool BEFORE it dispatches the call. */
export interface McpToolInfo {
	readonly access: McpToolAccess;
	/** True for the general SQL surface — the tools behind the `sql` or `sqlWrite` feature flag. */
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
	/** Directory exposed by `listWorkspaces` without adding workspace selection to data tools. */
	readonly discoveryDirectory?: WorkspaceDirectory;
	/** Feature flags for a workspace-scoped frontend with no directory. */
	readonly fixedFeatures?: WorkspaceFeatures;
	/**
	 * Per-call hooks, resolved from the same inputs as `getSql`. Frontends with a
	 * workspace-scoped connection omit it and every hook is a no-op.
	 */
	readonly getHooks?: (args: Record<string, unknown>, access: McpToolAccess) => McpToolHooks;
}

/** Add a required `wsid` enum property to a tool's input schema (non-destructively). */
function withWsid(
	inputSchema: Record<string, unknown>,
	wsids: string[],
): Record<string, unknown> {
	const rawProperties = inputSchema["properties"];
	const properties: Record<string, unknown> = typeof rawProperties === "object" && rawProperties !== null
		? Object.fromEntries(Object.entries(rawProperties))
		: {};
	properties["wsid"] = {
		type: "string",
		enum: wsids,
		description:
			"Workspace id (wsid). Required on every call to this tool. Call listWorkspaces to see the options.",
	};
	const schema: Record<string, unknown> = { ...inputSchema, properties };
	const raw = inputSchema["required"];
	const required: unknown[] = Array.isArray(raw) ? [...raw] : [];
	schema["required"] = required.includes("wsid") ? required : [...required, "wsid"];
	return schema;
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
	const feature = tool.feature;
	return Either.match(resolveWorkspace(config, args), {
		onRight: (workspace) => workspaceHasFeature(workspace, feature),
		// Let the connection resolver report invalid explicit workspace selection.
		onLeft: () => true,
	});
}

export function registerTools(
	server: Server,
	getSql: (
		args: Record<string, unknown>,
		access: McpToolAccess,
	) => Effect.Effect<Sql, Error> | Either.Either<Sql, Error>,
	config?: WorkspaceDirectory | null,
	options: RegisterToolsOptions = {},
): Either.Either<void, Error> {
	return tryOrOperationError(() => {
		const discoveryDirectory = config ?? options.discoveryDirectory;
		server.setRequestHandler(ListToolsRequestSchema, () =>
			Either.getOrThrowWith(
				tryOrOperationError(() => {
					const listed = tools.filter((tool) => isVisible(tool, config, options)).map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: config
							? withWsid(tool.inputSchema, eligibleWsids(tool, config))
							: tool.inputSchema,
					}));
					if (discoveryDirectory) {
						listed.unshift({
							name: LIST_WORKSPACES,
							description:
								"List the configured client workspaces (wsid, label, merchants and the countries each sells in). " +
								(config
									? "Use it to pick the explicit `wsid` required by every data tool."
									: "The connector URL fixes the active workspace; data tools need no `wsid` argument."),
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						});
					}
					return { tools: listed };
				}),
				(error) => error,
			));

		server.setRequestHandler(
			CallToolRequestSchema,
			(req: CallToolRequest, extra: { readonly signal: AbortSignal }) =>
				Effect.runPromiseExit(dispatch(req), { signal: extra.signal }).then(exitValue),
		);

		function dispatch(req: CallToolRequest): Effect.Effect<CallToolResult, Error> {
			return Effect.gen(function* () {
				const args = req.params.arguments ?? {};

				if (discoveryDirectory && req.params.name === LIST_WORKSPACES) {
					const text = yield* encodeToolResult(summarizeConfig(discoveryDirectory));
					return { content: [{ type: "text", text }] };
				}

				const tool = tools.find((t) => t.name === req.params.name);
				if (tool === undefined || !isAllowedForCall(tool, args, config, options)) {
					return yield* Effect.fail(new Error(`Unknown tool: ${req.params.name}`));
				}
				return yield* Effect.gen(function* () {
					const access = tool.access ?? "read";
					const resolve = yield* tryOrOperationError(() => getSql(args, access));
					const sql = yield* resolve;
					const hooks = yield* tryOrOperationError(() => options.getHooks?.(args, access));
					const result = yield* tool.run(args, sql, hooks);
					const text = yield* encodeToolResult(result);
					return { content: [{ type: "text" as const, text }] };
				}).pipe(Effect.catchAll((err) =>
					Effect.succeed({
						content: [{ type: "text" as const, text: `Error: ${err.message}` }],
						isError: true,
					})
				));
			});
		}
	});
}
