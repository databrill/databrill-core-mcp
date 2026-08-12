import type { Sql } from "postgres";
import { SQL_FEATURE } from "../../config.ts";
import type { McpToolHooks } from "../../toolHooks.ts";
import { describeTable } from "./load.ts";
import type { DescribeTableParams } from "./types.ts";

// No `schema` property, deliberately: the lookup is scoped to the connection's
// own schema search list and must not be pointable at another tenant's schema.
const inputSchema = {
	type: "object",
	properties: {
		table: {
			type: "string",
			description: "Bare table name, exactly as listTables reports it (case-sensitive, no schema qualifier).",
		},
	},
	required: ["table"],
	additionalProperties: false,
} as const;

function parseParams(args: Record<string, unknown>): DescribeTableParams {
	return { table: typeof args["table"] === "string" ? args["table"] : undefined };
}

export const describeTableTool = {
	name: "describeTable",
	feature: SQL_FEATURE,
	access: "read" as const,
	description: "Describe one table in this workspace's own schema: column names, data types, nullability and " +
		"defaults, in ordinal order. Takes a bare table name — there is no schema argument, so it can " +
		"only describe the caller's own schema. Use listTables to find the name.",
	inputSchema,
	run: (args: Record<string, unknown>, sql: Sql, hooks?: McpToolHooks) =>
		describeTable(parseParams(args), sql, hooks),
};
