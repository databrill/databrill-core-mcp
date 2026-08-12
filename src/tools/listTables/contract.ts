import type { Sql } from "postgres";
import { SQL_FEATURE } from "../../config.ts";
import type { McpToolHooks } from "../../toolHooks.ts";
import { listTables } from "./load.ts";

const inputSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

export const listTablesTool = {
	name: "listTables",
	feature: SQL_FEATURE,
	access: "read" as const,
	description: "List the tables and views in this workspace's own database schema, with their object type. " +
		"Start here before writing a query with executeSql, then use describeTable for column details. " +
		"Only the caller's own schema is visible — never another workspace's, never the system catalog.",
	inputSchema,
	run: (_args: Record<string, unknown>, sql: Sql, hooks?: McpToolHooks) => listTables(sql, hooks),
};
