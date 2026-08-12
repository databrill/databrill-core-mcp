import type { Sql } from "postgres";
import { SQL_WRITE_FEATURE } from "../../config.ts";
import type { McpToolHooks } from "../../toolHooks.ts";
import { STATEMENT_TIMEOUT_MS } from "../../sqlGuardrails.ts";
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
		"command tag, the affected row count, and any RETURNING rows.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql, hooks?: McpToolHooks) => writeSql(parseParams(args), sql, hooks),
};
