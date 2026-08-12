/**
 * `describeTable` — one table's columns, with data types and nullability.
 *
 * Takes a BARE table name and has no schema parameter, so it cannot be pointed
 * at another schema. What enforces that is the `table_schema = ANY(current_schemas(false))`
 * predicate — the same scoping idiom as `loadTflInventory/load.ts:129` and
 * `loadRank/load.ts:34` — not the name check below, which exists only so a
 * qualified name gets an actionable message instead of a silent "not found".
 *
 * See `../executeSql/execute.ts` for why the `mcp-local/CLAUDE.md`
 * feature-origination rule does not apply to this tool family.
 */

import type { Sql } from "postgres";
import type { McpToolHooks } from "../../toolHooks.ts";
import { withReadTransaction } from "../../sqlGuardrails.ts";
import type { DescribeTableParams, DescribeTableResult, TableColumn } from "./types.ts";

interface DbColumnRow {
	readonly schema: string;
	readonly position: number;
	readonly name: string;
	readonly dataType: string;
	readonly isNullable: string;
	readonly columnDefault: string | null;
}

function fail(message: string): never {
	throw new Error(message);
}

function parseTable(value: string | undefined): string {
	const table = value?.trim() ?? "";
	if (table === "") {
		fail("table is required and must be a bare table name");
	}
	if (/[."]/.test(table)) {
		fail(
			`table must be a bare table name with no schema qualifier or quoting; got "${table}". ` +
				"Only this workspace's own schema can be described.",
		);
	}
	return table;
}

export function describeTable(
	params: DescribeTableParams,
	sql: Sql,
	hooks?: McpToolHooks,
): Promise<DescribeTableResult> {
	const table = parseTable(params.table);

	return withReadTransaction(sql, hooks, async (tx) => {
		const schemaRows = await tx<Array<{ readonly schemas: readonly string[] }>>`
			SELECT current_schemas(false) AS "schemas"
		`;
		const schemas = [...(schemaRows[0]?.schemas ?? [])];

		const rows = await tx<DbColumnRow[]>`
			WITH "resolved" AS (
				SELECT "table_schema"
				FROM "information_schema"."columns"
				WHERE "table_name" = ${table}
					AND "table_schema" = ANY(current_schemas(false))
				GROUP BY "table_schema"
				ORDER BY array_position(current_schemas(false)::TEXT[], "table_schema"::TEXT) ASC
				LIMIT 1
			)
			SELECT
				"column"."table_schema" AS "schema",
				"column"."ordinal_position" AS "position",
				"column"."column_name" AS "name",
				"column"."data_type" AS "dataType",
				"column"."is_nullable" AS "isNullable",
				"column"."column_default" AS "columnDefault"
			FROM "information_schema"."columns" AS "column"
			INNER JOIN "resolved" ON "resolved"."table_schema" = "column"."table_schema"
			WHERE "column"."table_name" = ${table}
			ORDER BY "column"."ordinal_position" ASC
		`;

		const data: TableColumn[] = rows.map((row) => ({
			position: Number(row.position),
			name: row.name,
			dataType: row.dataType,
			isNullable: row.isNullable === "YES",
			columnDefault: row.columnDefault,
		}));

		return {
			meta: {
				table,
				schema: rows[0]?.schema ?? null,
				schemas,
				exists: data.length > 0,
				columnCount: data.length,
			},
			data,
		};
	});
}
