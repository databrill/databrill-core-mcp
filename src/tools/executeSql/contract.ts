import type { Sql } from "postgres";
import { SQL_FEATURE } from "../../config.ts";
import type { McpToolHooks } from "../../toolHooks.ts";
import { executeSql } from "./execute.ts";
import { DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, STATEMENT_TIMEOUT_MS } from "../../sqlGuardrails.ts";
import type { ExecuteSqlParams } from "./types.ts";

// No `timeout` property, deliberately: the per-call statement timeout is a
// validated constant in `sqlGuardrails.ts` and is never caller-controlled.
const inputSchema = {
	type: "object",
	properties: {
		sql: {
			type: "string",
			description: "Exactly ONE read-only SQL statement. Stacked statements are rejected by Postgres. " +
				"The connection is read-only: any write fails with a privilege error.",
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: MAX_ROW_LIMIT,
			default: DEFAULT_ROW_LIMIT,
			description: `Maximum rows to return (default ${DEFAULT_ROW_LIMIT}, maximum ${MAX_ROW_LIMIT}). ` +
				"A larger request is rejected rather than clamped.",
		},
	},
	required: ["sql"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): ExecuteSqlParams {
	return {
		sql: typeof args["sql"] === "string" ? args["sql"] : undefined,
		limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
	};
}

export const executeSqlTool = {
	name: "executeSql",
	feature: SQL_FEATURE,
	access: "read" as const,
	description: "Run one read-only SQL statement against this workspace's own database and return the rows. " +
		"Use listTables and describeTable first to discover the schema. Runs in a READ ONLY transaction " +
		`with a ${STATEMENT_TIMEOUT_MS}ms statement timeout; results are capped by row count and by ` +
		"serialized size, and the result says explicitly when and why it was truncated.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql, hooks?: McpToolHooks) => executeSql(parseParams(args), sql, hooks),
};
