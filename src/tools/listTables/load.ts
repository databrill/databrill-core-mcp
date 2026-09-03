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
 * The listing is narrowed twice, by the two rules `../../tableNames.ts` states. First to
 * the names this MCP supports, so that every name reported here feeds straight back into
 * `describeTable`. Then past Kysely's migration bookkeeping, which is not workspace data
 * and holds nothing an agent reading a listing can act on. That second rule is this tool's
 * alone: `describeTable` still answers for `kysely_migration` and `executeSql` still
 * queries it, so hiding a name here does not narrow the supported domain. A row dropped by
 * either rule is dropped silently: no warning, no marker row, and no count of what was
 * omitted — `meta.tableCount` comes from `data.length` and so reports what was returned.
 * That is deliberate. Neither kind of name is a workspace table worth reporting, and a
 * listing that omits it is the correct listing rather than a lossy one. Both filters run
 * in TypeScript over the rows the query returned, not in SQL: there is nothing to gain
 * from pushing them into the query, and the rules stay readable where they live.
 *
 * See `../executeSql/execute.ts` for why the `mcp-local/CLAUDE.md`
 * feature-origination rule does not apply to this tool family.
 */

import type { Sql } from "postgres";
import type { McpToolHooks } from "../../toolHooks.ts";
import { withReadTransaction } from "../../sqlGuardrails.ts";
import { isHiddenBookkeepingTableName, isSupportedTableName } from "../../tableNames.ts";
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

		const data: ListedTable[] = rows
			.filter((row) => isSupportedTableName(row.name))
			.filter((row) => !isHiddenBookkeepingTableName(row.name))
			.map((row) => ({ schema: row.schema, name: row.name, type: row.type }));
		return { meta: { schemas: [...schemas], tableCount: data.length }, data };
	});
}
