/**
 * The two table-name rules this MCP states, defined once for `listTables` and `describeTable`.
 *
 * 1. Which names this MCP SUPPORTS — `isSupportedTableName`, shared by both tools.
 * 2. Which names `listTables` HIDES — `isHiddenBookkeepingTableName`, used by that tool alone.
 *
 * They are separate rules with separate reach, and rule 2 is not a narrowing of rule 1.
 *
 * Rule 1 is a statement about THIS MCP's domain, not about PostgreSQL's. Postgres will
 * happily hold a table called `daily.metrics` or `` spaced ``; a Databrill table is
 * never named that way, and a name outside the domain below is not one this tool
 * surface undertakes to handle. So `listTables` does not report such a name, and
 * `describeTable` does not accept one — which is the whole point of keeping the rule
 * here rather than in either tool: every name the one tool reports is a name the other
 * takes back, byte for byte.
 *
 * Rule 2 keeps Kysely's migration bookkeeping (`kysely_migration`, `kysely_migration_lock`)
 * out of a listing: it is bookkeeping, not workspace data, and an agent reading a
 * workspace's tables has nothing there worth reasoning about. It applies to the LISTING
 * ONLY — `describeTable("kysely_migration")` still answers with the columns, and
 * `executeSql` still queries the table for a caller who names it. That is why it is its
 * own predicate and must never be folded into `isSupportedTableName`: doing so would make
 * `describeTable` refuse a table that plainly exists, which is a worse answer than its
 * columns.
 *
 * The rule 2 match is a SUBSTRING, so a table a workspace created for itself through
 * `writeSql` and named `kysely_migration_export` is hidden from a listing too. That is
 * accepted, not overlooked, and it is not the failure the allowlist paragraph below
 * rejects: hiding removes a name from ONE listing, while `describeTable` and `executeSql`
 * both still reach it by name. Should a real customer table ever collide, the remedy is to
 * narrow the match — anchoring it to the start of the name would do it, at the cost of the
 * prefixed variants `tests/unit/tableNames.test.ts` currently pins as hidden.
 *
 * NEITHER rule is a security boundary and neither must ever be read as one. What confines
 * both tools to the caller's own schema is the `table_schema = ANY(current_schemas(false))`
 * predicate and the fact that the name travels as a bind parameter — see
 * `sqlGuardrails.ts`, whose module doc says why nothing that pattern-matches caller
 * input may be trusted to decide what a statement may touch. Widening the domain here
 * would show more tables in a listing; it would not reach another tenant.
 *
 * Rule 1 is deliberately not an `[A-Za-z0-9_]+` allowlist, though every table Databrill
 * itself creates would pass one: `writeSql` lets a workspace create tables of its own, and
 * an allowlist would hide a customer's `my report` from both tools forever. Widening this
 * rule later adds rows to a listing; narrowing it removes them.
 */

/** The domain in one line. Quote this in tool descriptions and error text; do not restate it. */
export const SUPPORTED_TABLE_NAME_RULE =
	"A supported table name is non-empty and contains no dot, no double-quote character, " +
	"and no leading or trailing whitespace.";

/** The one place the matched substring is written. Interpolated into the rule sentence below. */
const KYSELY_MIGRATION_FRAGMENT = "kysely_migration";

/** The hiding rule in one line. Quote this in tool descriptions; do not restate it. */
export const HIDDEN_BOOKKEEPING_TABLE_NAME_RULE =
	`A migration bookkeeping table is one whose name contains "${KYSELY_MIGRATION_FRAGMENT}" in any letter case.`;

/** Does this MCP support `value` as a table name? See `SUPPORTED_TABLE_NAME_RULE`. */
export function isSupportedTableName(value: string): boolean {
	if (value === "") {
		return false;
	}
	if (value.includes(".") || value.includes('"')) {
		return false;
	}
	// Compares against the whole trimmed string, so a whitespace-only name is excluded too.
	return value === value.trim();
}

/** Is `value` migration bookkeeping rather than workspace data? See `HIDDEN_BOOKKEEPING_TABLE_NAME_RULE`. */
export function isHiddenBookkeepingTableName(value: string): boolean {
	// A substring match covers `kysely_migration_lock` and any prefixed or suffixed variant a
	// future migration setup creates; case-insensitive because a name created through a quoted
	// identifier is not lower-cased by Postgres.
	return value.toLowerCase().includes(KYSELY_MIGRATION_FRAGMENT);
}
