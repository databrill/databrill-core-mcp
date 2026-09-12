/**
 * Execute a compiled Kysely query on an injected postgres.js connection, and
 * refuse the one shape of compiled query that is unsafe to run.
 *
 * WHY THIS EXISTS. Kysely is the COMPILER here and postgres.js stays the DRIVER:
 * a loader builds a query against the generated tenant `DB` interface, calls
 * `.compile()`, and hands the resulting `{ sql, parameters }` to the connection
 * the caller injected. `executeCompiled` does that hand-off. What it cannot do
 * is notice that the parameter list came out EMPTY, and an empty parameter list
 * is a protocol downgrade:
 *
 *   postgres.js picks the protocol from the argument count — see
 *   `node_modules/postgres/src/index.js`, `unsafe(string, args = [], options =
 *   {})` sets `simple: 'simple' in options ? options.simple : args.length ===
 *   0`. A bare `sql.unsafe(query)` therefore runs on the SIMPLE protocol, which
 *   EXECUTES STACKED STATEMENTS; passing a non-empty `values` array selects the
 *   EXTENDED protocol, where Postgres rejects `SELECT 1; SELECT 2` outright with
 *   `42601`. This is the same driver trap `executeSql`'s guardrails close by
 *   forcing `simple: false`.
 *
 * So {@link runCompiled} fails on a zero-parameter compiled query rather than
 * running it, and {@link boundTrue} is the remedy for the rare query that has no
 * natural value to bind. A loud failure in a test run is the point: the
 * alternative is a silent downgrade nothing else in the package would notice.
 *
 * Placeholder numbering is by ORDER OF ALLOCATION, not order of appearance in
 * the query text — `$3` may legally precede `$1`. That is Kysely's business and
 * is fine; what matters here is only that the list is not empty.
 *
 * This module WRAPS `executeCompiled`, it does not replace it: the canonical
 * readers keep calling it internally, and nothing here opens a connection.
 */

import { Effect } from "effect";
import { type CanonicalQueryRunner, executeCompiled } from "@jsr/databrill__core-pg-kysely/canonical";
import { type CompiledQuery, type RawBuilder, sql, type SqlBool } from "kysely";
import { tryOrOperationError } from "./effectErrors.ts";

/**
 * Execute a compiled query or compilation function on `runner`, refusing a query that binds nothing.
 * A compilation function runs when the Effect executes; thrown errors become typed failures.
 *
 * `runner` is the injected postgres.js `Sql`, which satisfies
 * `CanonicalQueryRunner` structurally — pass it straight in.
 */
export function runCompiled<O>(
	runner: CanonicalQueryRunner,
	query: CompiledQuery<O> | (() => CompiledQuery<O>),
): Effect.Effect<O[], Error> {
	return Effect.gen(function* () {
		const compiled = typeof query === "function" ? yield* tryOrOperationError(query) : query;
		if (compiled.parameters.length === 0) {
			return yield* Effect.fail(
				new Error(
					`Refusing to run a compiled query with no bind parameters: postgres.js selects the SIMPLE protocol ` +
						`when the parameter list is empty, and stacked statements execute there. Bind at least one ` +
						`value, or add boundTrue(). SQL: ${compiled.sql}`,
				),
			);
		}
		return yield* executeCompiled(runner, compiled);
	});
}

/** A bound `true` predicate, for a query with no natural value to bind. Compiles to `$n`. */
export function boundTrue(): RawBuilder<SqlBool> {
	return sql<SqlBool>`${sql.val(true)}`;
}

/**
 * Bind an ISO `YYYY-MM-DD` string for comparison against a `date` column.
 *
 * The generated interface types those columns as
 * `ColumnType<Temporal.PlainDate, Temporal.PlainDate | string, …>`, and Kysely
 * resolves a comparison operand against the SELECT type, so a bare string is
 * rejected. The `Temporal.PlainDate` here is a generic argument to `sql`, not an
 * assertion: the bound value is still the ISO string, byte-identical to what the
 * tagged templates bound before, which matters because only one of this
 * package's three consumers installs a Temporal serializer for postgres.js.
 */
export function isoDateParam(value: string): RawBuilder<Temporal.PlainDate> {
	return sql<Temporal.PlainDate>`${value}`;
}
