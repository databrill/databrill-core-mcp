/**
 * A bind-parameter accumulator for the loaders that assemble their SQL by string
 * concatenation (`loadAds`, `loadTraffic`).
 *
 * WHY THIS EXISTS. Those loaders build a query out of fragments and then hand it
 * to `sql.unsafe(...)`. Any value spliced into such a fragment as a quoted
 * literal is an injection site, and the values are not all caller-authored: some
 * are read back out of client tables (`brand_config_amazon_asin.asin`,
 * `amazon_store."merchantId"` / `"storeName"`), which makes it a SECOND-ORDER
 * injection — a poisoned row written once is executed by every later load.
 *
 * Bind parameters close it twice over:
 *   1. a parameter is a value, never syntax, so nothing it contains can end the
 *      literal and start a new statement; and
 *   2. postgres.js picks the protocol from the argument count — see
 *      `node_modules/postgres/src/index.js`, `unsafe(string, args = [], options
 *      = {})` sets `simple: 'simple' in options ? options.simple : args.length
 *      === 0`. A bare `sql.unsafe(query)` therefore runs on the SIMPLE protocol,
 *      which EXECUTES STACKED STATEMENTS; passing a non-empty `values` array
 *      selects the EXTENDED protocol, where Postgres rejects `SELECT 1; SELECT 2`
 *      outright with `42601`. This is the same driver trap `executeSql`'s
 *      guardrails close by forcing `simple: false`.
 *
 * Placeholder numbering is by ORDER OF ALLOCATION, not order of appearance in
 * the query text — `$3` may legally precede `$1`. What must hold is that every
 * allocated placeholder actually reaches the final query string (Postgres errors
 * if the bind supplies more parameters than the statement references), so only
 * call `add` while splicing its return value into a fragment you will keep.
 *
 * One accumulator belongs to one `sql.unsafe` call: separate statements have
 * separate parameter lists.
 */
export interface SqlParams {
	/** Bound values, in `$1..$n` order. Pass as the second argument to `sql.unsafe`. */
	readonly values: string[];

	/** Bind `value` and return the `$n` placeholder that references it. */
	readonly add: (value: string) => string;

	/** Bind every value and return the placeholders joined for an `IN (...)` list. */
	readonly addList: (values: readonly string[]) => string;
}

export function createSqlParams(): SqlParams {
	const values: string[] = [];

	function add(value: string): string {
		values.push(value);
		return `$${values.length}`;
	}

	return {
		values,
		add,
		addList: (list) => list.map(add).join(", "),
	};
}
