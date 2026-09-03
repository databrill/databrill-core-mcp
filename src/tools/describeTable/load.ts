/**
 * `describeTable` — one table's columns, with data types and nullability.
 *
 * Takes a BARE table name — meaning there is no schema argument to point at another
 * schema, NOT that the caller should add quoting of their own. What confines the
 * lookup is the `table_schema = ANY(current_schemas(false))` predicate — the same
 * scoping idiom as `loadTflInventory/load.ts:129` and `loadRank/load.ts:34` — plus
 * the fact that the name travels as a bind parameter. The name check below is not
 * part of that and never was.
 *
 * What the check IS for: it holds this tool to the same domain of table names that
 * `listTables` draws its listing from, defined once in `../../tableNames.ts`. Every
 * name that tool lists is accepted here byte for byte. The reverse does not hold and
 * never needed to: `listTables` also hides migration bookkeeping, which this tool
 * still describes. A name outside the domain is refused with a message that names it
 * — which is also what still gives a schema-qualified name an actionable answer
 * instead of a silent "not found".
 *
 * The caller's literal string is what gets queried and what `meta.table` echoes back.
 * It is deliberately not trimmed: reformatting a name before looking it up would
 * describe a table the caller did not name, and would leave the domain's
 * no-edge-whitespace clause unable to fire here at all.
 *
 * See `../executeSql/execute.ts` for why the `mcp-local/CLAUDE.md`
 * feature-origination rule does not apply to this tool family.
 */

import type { Sql } from "postgres";
import type { McpToolHooks } from "../../toolHooks.ts";
import { withReadTransaction } from "../../sqlGuardrails.ts";
import { isSupportedTableName, SUPPORTED_TABLE_NAME_RULE } from "../../tableNames.ts";
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
	const table = value ?? "";
	if (table === "") {
		fail("table is required and must be a bare table name");
	}
	if (!isSupportedTableName(table)) {
		fail(
			`table is not a name this MCP supports; got "${table}". ${SUPPORTED_TABLE_NAME_RULE} ` +
				"Pass the name exactly as listTables reports it — no schema qualifier, no quoting of your own. " +
				"This is not a report that the table is missing.",
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
