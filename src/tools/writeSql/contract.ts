import type { Sql } from "postgres";
import { SQL_WRITE_FEATURE } from "../../config.ts";
import type { McpToolHooks } from "../../toolHooks.ts";
import { MAX_RESULT_BYTES, MAX_ROW_LIMIT, STATEMENT_TIMEOUT_MS } from "../../sqlGuardrails.ts";
import type { WriteSqlParams } from "./types.ts";
import { writeSql } from "./write.ts";

const inputSchema = {
	type: "object",
	properties: {
		sql: {
			type: "string",
			description: "Exactly ONE SQL statement. Stacked statements are rejected by Postgres. The write role is " +
				"granted on this workspace's configuration tables only; anything else fails with a " +
				"privilege error and nothing is written.",
		},
	},
	required: ["sql"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): WriteSqlParams {
	return { sql: typeof args["sql"] === "string" ? args["sql"] : undefined };
}

export const writeSqlTool = {
	name: "writeSql",
	// `sqlWrite`, not `sql`: this tool is announced independently of the read tools.
	feature: SQL_WRITE_FEATURE,
	access: "write" as const,
	description: "Run one write statement against this workspace's configuration tables. The statement commits " +
		"only if the workspace's write role has been granted on the target table; pipeline data tables " +
		`are refused by Postgres. Runs with a ${STATEMENT_TIMEOUT_MS}ms statement timeout and returns the ` +
		"command tag, how many rows the statement affected, and its RETURNING rows — capped at " +
		`${MAX_ROW_LIMIT} rows and by the ${MAX_RESULT_BYTES}-byte size of the compact JSON response ` +
		"(metadata included). A cap bounds only what comes back: the statement always runs and commits in " +
		"full, meta.rowsAffected reports its true total, and meta.isTruncated says when a cap applied. Do " +
		"not re-run a truncated statement, which would repeat the write; read the rest with executeSql.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql, hooks?: McpToolHooks) => writeSql(parseParams(args), sql, hooks),
};
