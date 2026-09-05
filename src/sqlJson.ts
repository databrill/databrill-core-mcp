/**
 * JSONB path fragments for queries built with Kysely.
 *
 * WHY NOT THE BUILDER'S OWN API. Kysely has a typed JSON traversal API,
 * `eb.ref(column, '->>')` followed by `.key(name)`. It does not type-check
 * against this schema. The generated interface types every `json`/`jsonb` column
 * as `Json = JsonArray | JsonObject | JsonPrimitive`, and `JSONPathBuilder.key()`
 * cannot resolve a key against that union — the parameter collapses to `never`
 * and every call fails with `TS2345: Argument of type '"unitsOrdered"' is not
 * assignable to parameter of type 'never'`. Separately, Kysely applies ONE
 * operator to a whole path, so a mixed `->` … `->>` path such as
 * `"creative"->'products'->0->>'productId'` has no builder form even if the
 * typing worked. A `sql` fragment with typed column references is the working
 * form; the column reference is still checked against `DB`, and the fragment
 * names no relation, so a future `.withSchema()` leaves nothing unqualified here.
 *
 * PATH KEYS GO THROUGH `sql.lit`, NEVER A BIND PARAMETER. They are source-code
 * literals, never caller data, so there is nothing to bind against — and more
 * importantly, Postgres matches a GROUP BY expression against a SELECT
 * expression by parse-tree equality, and two `Param` nodes with different
 * placeholder numbers are not equal. A bound key would make
 * `SELECT "doc"->>$1 … GROUP BY "doc"->>$2` fail at runtime with `column …
 * must appear in the GROUP BY clause`, with no type error to warn you.
 */

import { type Expression, type RawBuilder, sql } from "kysely";

/**
 * At least one segment, so a caller cannot ask for an empty path. With an empty
 * path there is no `->>` to emit: `jsonbText` would return the raw `jsonb`
 * column while claiming `string | null`, and `jsonbInt` would emit `("doc")::int`,
 * which Postgres rejects — inside one of `lowInventory`'s best-effort `try/catch`
 * blocks that rejection is swallowed and reads as missing data.
 */
type JsonbPath = [segment: string | number, ...rest: (string | number)[]];

function jsonbPathText(column: Expression<unknown>, path: JsonbPath): RawBuilder<unknown> {
	let expr: RawBuilder<unknown> = sql`${column}`;
	const last = path.length - 1;
	path.forEach((segment, index) => {
		expr = index === last ? sql`${expr}->>${sql.lit(segment)}` : sql`${expr}->${sql.lit(segment)}`;
	});
	return expr;
}

/** `"col"->'a'->0->>'b'` — a JSONB path ending in the TEXT operator. */
export function jsonbText(column: Expression<unknown>, ...path: JsonbPath): RawBuilder<string | null> {
	return sql<string | null>`${jsonbPathText(column, path)}`;
}

/** `("col"->'a'->>'b')::int` — the same path, cast to integer, parenthesised. */
export function jsonbInt(column: Expression<unknown>, ...path: JsonbPath): RawBuilder<number | null> {
	return sql<number | null>`(${jsonbPathText(column, path)})::int`;
}
