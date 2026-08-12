/**
 * `listTables` — the tables and views visible in the caller's OWN schema.
 *
 * Scoped with `current_schemas(false)`, the idiom `loadTflInventory/load.ts` and
 * `loadRank/load.ts` already use: it is the connection's effective search list
 * with the implicit system schemas excluded, so this cannot enumerate another
 * tenant's tables or the system catalog. The role's `search_path` is set on the
 * role itself, so the scope travels with the connection rather than with any
 * argument a caller could supply — there is no schema parameter to point
 * elsewhere.
 *
 * See `../executeSql/execute.ts` for why the `mcp-local/CLAUDE.md`
 * feature-origination rule does not apply to this tool family.
 */

import type { Sql } from "postgres";
import type { McpToolHooks } from "../../toolHooks.ts";
import { withReadTransaction } from "../../sqlGuardrails.ts";
import type { ListedTable, ListTablesResult } from "./types.ts";

interface DbTableRow {
	readonly schema: string;
	readonly name: string;
	readonly type: string;
}

export function listTables(sql: Sql, hooks?: McpToolHooks): Promise<ListTablesResult> {
	return withReadTransaction(sql, hooks, async (tx) => {
		const schemaRows = await tx<Array<{ readonly schemas: readonly string[] }>>`
			SELECT current_schemas(false) AS "schemas"
		`;
		const schemas = schemaRows[0]?.schemas ?? [];

		const rows = await tx<DbTableRow[]>`
			SELECT
				"table_schema" AS "schema",
				"table_name" AS "name",
				"table_type" AS "type"
			FROM "information_schema"."tables"
			WHERE "table_schema" = ANY(current_schemas(false))
			ORDER BY "table_schema" ASC, "table_name" ASC
		`;

		const data: ListedTable[] = rows.map((row) => ({ schema: row.schema, name: row.name, type: row.type }));
		return { meta: { schemas: [...schemas], tableCount: data.length }, data };
	});
}
