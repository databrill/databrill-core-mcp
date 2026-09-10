/**
 * The layered execution guards wrapped around every caller-authored statement,
 * shared by `executeSql` and `writeSql`.
 *
 * These are LAYERS, never the boundary. The read/write boundary is the executing
 * Postgres role's grants and nothing else. Nothing here parses, pattern-matches
 * or rewrites the caller's SQL to decide whether it may run: SQL parsing is
 * defeated by functions and `DO` blocks and must never be a security boundary.
 * The guards bound what a statement may CONSUME (one statement, bounded time)
 * and what it may RETURN (bounded rows, bounded bytes); they never decide what
 * it may TOUCH.
 *
 * The one driver trap this module exists to close: postgres.js `unsafe(string,
 * args = [], options = {})` sets `simple: 'simple' in options ? options.simple
 * : args.length === 0`, so a bare `sql.unsafe(query)` selects the SIMPLE query
 * protocol — which happily EXECUTES STACKED STATEMENTS. Every statement here is
 * therefore run through `.cursor(...)`, which sets `this.options.simple = false`
 * and forces the EXTENDED protocol, where `SELECT 1; SELECT 2` is rejected by
 * Postgres with `42601`. There is deliberately NO fetch-all path in this module:
 * a plain `await sql.unsafe(text)` would silently reopen the trap.
 */

import type { Sql, TransactionSql } from "postgres";
import type { McpToolHooks } from "./toolHooks.ts";

/** Which cap stopped accumulation, when one did. */
export type TruncationCap = "rows" | "bytes";

/** One result row, as postgres.js hands it back: column name → value. */
export type SqlRow = Record<string, unknown>;

/**
 * Per-call statement timeout, in milliseconds. A validated integer CONSTANT —
 * it is never taken from caller input, and no tool input schema accepts a
 * timeout. 15s leaves ample headroom under the hosted maximum call lifetime.
 */
export const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Default and maximum row caps, mirroring the `loadTflInventory` precedent.
 *
 * `executeSql` starts at the default and lets a caller ask for up to the maximum.
 * `writeSql` has no `limit` input and always uses the MAXIMUM, because a write
 * caller cannot ask again — see `src/tools/writeSql/write.ts`.
 */
export const DEFAULT_ROW_LIMIT = 500;
export const MAX_ROW_LIMIT = 1000;

/**
 * The result byte cap: 2 MiB, measured over the COMPACT JSON text of the whole
 * tool result — the `meta` object, the `data` array and its punctuation — as
 * `encodeToolResult` produces it. Not over `data` alone, and not over the JSON-RPC
 * frame that carries the text, whose escaping is the transport's business.
 */
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;

/** Rows fetched per cursor round trip. Bounds memory without a round trip per row. */
const CURSOR_CHUNK_ROWS = 100;

/**
 * A stand-in for `meta.command` while a byte reserve is computed, which happens
 * BEFORE the statement runs and its tag is known. postgres.js takes the tag from
 * Postgres's `CommandComplete` with the trailing counts stripped
 * (`node_modules/postgres/src/connection.js:590-600`), so it is one of Postgres's
 * own command tags; the longest of those is `CREATE MATERIALIZED VIEW`, at 24
 * characters. 64 covers every tag with room to spare, and costs 64 bytes of a
 * 2 MiB cap.
 *
 * Shared by `executeSql` and `writeSql`, which derive their own reserves over
 * their own `meta` shapes but bound this one field with the same Postgres fact.
 */
export const COMMAND_TAG_RESERVE = "x".repeat(64);

/**
 * What an unrecoverable non-Postgres failure is reported as. Driver-level errors
 * carry the host and port in their message (`write CONNECTION_CLOSED host:port`),
 * so their text NEVER reaches the client.
 */
const OPAQUE_FAILURE = "The database connection failed before the statement completed.";

export interface RowBudget {
	readonly rowLimit: number;
	/** The cap on the WHOLE encoded result, envelope included. */
	readonly byteLimit: number;
	/**
	 * How much of `byteLimit` is NOT available to row text: the `meta` object and
	 * the truncation notice. Derived with `envelopeByteLength` from the worst-case
	 * `meta` the call can produce — never guessed. Without it, a result that filled
	 * the budget with rows would leave no room for the notice saying it was
	 * truncated, and the encoded result would land above the cap it just reported.
	 */
	readonly envelopeReserveBytes: number;
}

interface SqlErrorInfo {
	readonly code: string | null;
	readonly message: string;
	readonly position: number | null;
}

interface ReadExecution {
	/**
	 * The Postgres command tag (`SELECT`, `EXPLAIN`, `SHOW`, …), or `null` when the
	 * read stopped early at a cap and the tag was therefore never received.
	 */
	readonly command: string | null;
	readonly rows: readonly SqlRow[];
	readonly truncatedBy: TruncationCap | null;
}

interface WriteExecution {
	/** The Postgres command tag (`INSERT`, `UPDATE`, `CREATE TABLE`, …). */
	readonly command: string;
	/**
	 * How many rows the statement AFFECTED, or `null` for a command whose tag
	 * carries no count. Not the number returned: a truncated result still reports
	 * the whole total here.
	 */
	readonly rowsAffected: number | null;
	/** Rows produced by a `RETURNING` clause, bounded by the caller's budget. */
	readonly rows: readonly SqlRow[];
	/** Which cap bounded `rows`, or `null` when every returned row fit. */
	readonly truncatedBy: TruncationCap | null;
}

interface RowAccumulator {
	/** Add one cursor chunk. Returns `false` once a cap trips and reading must stop. */
	readonly add: (chunk: readonly SqlRow[]) => boolean;
	readonly rows: () => readonly SqlRow[];
	readonly truncatedBy: () => TruncationCap | null;
}

const TOOL_HOOK_ERROR_TAG = "ToolHookError";

/**
 * A failure raised by the BINDING FRONTEND's own hook rather than by the database.
 *
 * It exists so an identity-assertion failure is not reported as a connection
 * failure: the frontend authored that message and owns what it says, and a
 * tenant-routing bug misreported as "the connection failed" costs hours. Anything
 * driver-shaped is still redacted before it gets here.
 *
 * A TAGGED `Error`, not a subclass: the `_tag` discriminant is what
 * `rethrowRedacted` tests, and it survives everything an `instanceof` check does
 * not (a value that crossed a realm, a structured clone). It stays a real `Error`
 * because the value is THROWN, and every frontend that catches it — including
 * `registerTools` — renders `err instanceof Error ? err.message : String(err)`; a
 * plain object would reach the client as `[object Object]` and lose the message
 * this type exists to preserve.
 */
export interface ToolHookError extends Error {
	readonly _tag: typeof TOOL_HOOK_ERROR_TAG;
}

export function toolHookError(message: string): ToolHookError {
	return Object.assign(new Error(message), { _tag: TOOL_HOOK_ERROR_TAG, name: TOOL_HOOK_ERROR_TAG } as const);
}

export function isToolHookError(err: unknown): err is ToolHookError {
	return err instanceof Error && fieldOf(err, "_tag") === TOOL_HOOK_ERROR_TAG;
}

function fail(message: string): never {
	throw new Error(message);
}

/** Read one property off a value of unknown shape without a type assertion. */
function fieldOf(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

const encoder = new TextEncoder();

/**
 * Encode a tool result as the text the client receives: COMPACT JSON, no indent
 * argument. This is the ONLY place an MCP tool result becomes text, and every
 * byte number below is measured through it, so the number the cap is defined over
 * and the number that is actually produced cannot be two different things.
 *
 * They were. Indentation costs two spaces per nesting level on every line, so it
 * is unbounded in the DEPTH of a value rather than its size: a thousand rows each
 * holding a depth-100 value summed to about 227 KB of row text and pretty-printed
 * to over 21 MB, under a 2 MiB cap the per-row sum reported as met. Compact
 * encoding removes that amplification outright and leaves the per-row sum exact
 * to the envelope.
 *
 * The cost is that a raw response is harder for a person to read. It is paid on
 * every response, whose reader is a language model; `bin/cli.ts` still prints
 * tab-indented JSON for the human case.
 */
export function encodeToolResult(result: unknown): string {
	return JSON.stringify(result);
}

/** UTF-8 byte length of the text `encodeToolResult` produces. */
export function encodedByteLength(result: unknown): number {
	return encoder.encode(encodeToolResult(result)).length;
}

/**
 * What one row contributes to the encoded result, in the SAME encoding — this is
 * the number `createRowAccumulator` sums, and it is `encodeToolResult` applied to
 * the row rather than a second stringify that could drift from it.
 */
export function serializedByteLength(row: SqlRow): number {
	return encodedByteLength(row);
}

/**
 * What a result's wrapper costs: the encoded length of `{ meta, data: [] }`.
 *
 * With compact encoding the total is exact and has three terms —
 *
 *     total(n) = envelopeByteLength(meta) + SUM_i serializedByteLength(row_i) + max(0, n - 1)
 *
 * — the last term being the commas between the array's elements. Verified with
 * delta 0 at n = 0, 1, 2, 10, 137 and 1000 over rows containing quotes, tabs,
 * newlines and multibyte text.
 *
 * Generic over the `meta` shape on purpose: `writeSql`'s meta carries
 * `rowsAffected` and `returnedRowCount` rather than `executeSql`'s fields, and it
 * has to compute its own reserve from this function rather than a second rule.
 */
export function envelopeByteLength(meta: object): number {
	return encodedByteLength({ meta, data: [] });
}

/**
 * Validate a caller-requested row cap. A request ABOVE the maximum is REJECTED
 * with a message naming the maximum rather than silently clamped, so an agent
 * learns the ceiling instead of receiving less than it asked for with no warning.
 */
export function parseRowLimit(value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_ROW_LIMIT;
	}
	if (!Number.isInteger(value) || value < 1) {
		fail(`limit must be a whole number of at least 1 (maximum ${MAX_ROW_LIMIT})`);
	}
	if (value > MAX_ROW_LIMIT) {
		fail(`limit ${value} exceeds the maximum of ${MAX_ROW_LIMIT} rows; request ${MAX_ROW_LIMIT} or fewer`);
	}
	return value;
}

/** Validate the caller's statement is present and non-blank. Its CONTENT is never inspected. */
export function parseStatement(value: string | undefined): string {
	const statement = value?.trim() ?? "";
	if (statement === "") {
		fail("sql is required and must be a non-empty SQL statement");
	}
	return statement;
}

/**
 * Accumulate rows until a cap trips. Both caps are checked BEFORE a row is kept,
 * and the row cap only trips on a row BEYOND the limit — so a query returning
 * exactly `rowLimit` rows reports itself complete rather than falsely truncated.
 *
 * `bytes` starts at the envelope reserve and adds the comma that precedes every
 * row after the first, so it is not a proxy for the payload — it IS the encoded
 * length of the result so far, the closed form in `envelopeByteLength` evaluated
 * one row at a time. That costs one encode per row, the same order as before, and
 * never re-encodes the growing result.
 */
export function createRowAccumulator(budget: RowBudget): RowAccumulator {
	const rows: SqlRow[] = [];
	let bytes = budget.envelopeReserveBytes;
	let truncatedBy: TruncationCap | null = null;

	return {
		add(chunk) {
			for (const row of chunk) {
				if (rows.length >= budget.rowLimit) {
					truncatedBy = "rows";
					return false;
				}
				const rowBytes = serializedByteLength(row) + (rows.length === 0 ? 0 : 1);
				if (bytes + rowBytes > budget.byteLimit) {
					truncatedBy = "bytes";
					return false;
				}
				rows.push(row);
				bytes += rowBytes;
			}
			return true;
		},
		rows: () => rows,
		truncatedBy: () => truncatedBy,
	};
}

/**
 * The notice that tells an agent "there is more" and WHICH cap stopped the read.
 *
 * `keptRowCount` is how many rows survived the caps. It only changes the byte-cap
 * wording, and only in the zero-rows case: "return fewer rows" is not a remedy
 * the caller can act on when not even the FIRST row fit.
 */
export function truncationNotice(
	truncatedBy: TruncationCap | null,
	budget: RowBudget,
	keptRowCount: number,
): string | null {
	if (truncatedBy === "rows") {
		return `Truncated at the ${budget.rowLimit}-row cap: more rows match. ` +
			`Narrow the query, aggregate, or raise limit (maximum ${MAX_ROW_LIMIT}).`;
	}
	if (truncatedBy === "bytes") {
		if (keptRowCount === 0) {
			// Zero rows fit, so the first row ALONE is over the cap. The reachable
			// instance is `EXPLAIN (FORMAT JSON)`, whose entire plan is one row —
			// for which the generic "select fewer or narrower columns" advice below
			// names nothing the caller can actually do.
			return `The first row alone exceeded the ${budget.byteLimit}-byte cap on the compact JSON ` +
				"result (metadata included), so no rows are returned. Project fewer or narrower " +
				"columns from that one row, or — for a query plan — use EXPLAIN without FORMAT JSON, " +
				"which returns one row per plan line.";
		}
		return `Truncated at the ${budget.byteLimit}-byte cap on the compact JSON result (metadata ` +
			`included) before the ${budget.rowLimit}-row cap: more rows match. ` +
			"Select fewer or narrower columns.";
	}
	return null;
}

/**
 * The write path's own truncation notice, and the reason it is not
 * `truncationNotice` above.
 *
 * All three read wordings end by telling the caller to narrow, aggregate or raise
 * `limit` and ask again. Asking again repeats a write. So every wording here says
 * three things the read wordings must not: the statement already ran and committed
 * in full, a cap bounded only what came back, and the way to obtain the rest is
 * `executeSql` rather than a second run of the same statement.
 *
 * `keptRowCount` only changes the byte-cap wording, and only in the zero-rows case,
 * for the same reason it does there: "select fewer columns and read the rest" names
 * nothing the caller can act on when not even the FIRST row fit.
 */
export function writeTruncationNotice(
	truncatedBy: TruncationCap | null,
	budget: RowBudget,
	keptRowCount: number,
): string | null {
	if (truncatedBy === null) {
		return null;
	}
	const ran = "The statement ran and committed in full; the cap bounds only what was returned. " +
		"Do NOT re-run it, which would repeat the write. ";
	if (truncatedBy === "rows") {
		return `Truncated at the ${budget.rowLimit}-row cap: the statement returned more rows than are ` +
			`shown, and meta.rowsAffected is how many. ` + ran + "Read the rest with executeSql.";
	}
	if (keptRowCount === 0) {
		return `The first row alone exceeded the ${budget.byteLimit}-byte cap on the compact JSON result ` +
			"(metadata included), so no rows are returned. " + ran +
			"Read that row with executeSql, projecting fewer or narrower columns.";
	}
	return `Truncated at the ${budget.byteLimit}-byte cap on the compact JSON result (metadata included) ` +
		`before the ${budget.rowLimit}-row cap: the statement returned more rows than are shown, and ` +
		"meta.rowsAffected is how many. " + ran +
		"Read the rest with executeSql, selecting fewer or narrower columns.";
}

/**
 * Reduce a failure to the three fields an agent needs to correct its own SQL —
 * `code`, `message`, `position` — and nothing else. Anything that is not a
 * Postgres server error becomes an opaque message: driver errors name the host
 * and port, and no host, port, database, role or credential may reach a client.
 * The server's own message IS returned, because it is what makes a syntax or
 * privilege failure actionable.
 */
export function describeSqlError(err: unknown): SqlErrorInfo {
	const code = fieldOf(err, "code");
	const message = fieldOf(err, "message");
	if (fieldOf(err, "name") !== "PostgresError" || typeof code !== "string" || typeof message !== "string") {
		return { code: null, message: OPAQUE_FAILURE, position: null };
	}
	return { code, message, position: parsePosition(fieldOf(err, "position")) };
}

function parsePosition(raw: unknown): number | null {
	if (typeof raw === "number" && Number.isInteger(raw)) {
		return raw;
	}
	if (typeof raw === "string" && /^\d+$/.test(raw)) {
		return Number(raw);
	}
	return null;
}

/** Render a redacted error for the tool result. */
export function formatSqlError(info: SqlErrorInfo): string {
	if (info.code === null) {
		return info.message;
	}
	const at = info.position === null ? "" : ` at position ${info.position}`;
	return `SQL error ${info.code}${at}: ${info.message}`;
}

/** Rethrow any database failure as a redacted, actionable error. */
export function rethrowRedacted(err: unknown): never {
	if (isToolHookError(err)) {
		throw err;
	}
	throw new Error(formatSqlError(describeSqlError(err)));
}

/**
 * `SET LOCAL statement_timeout` built from the validated constant. The value is
 * interpolated because Postgres does not accept a bind parameter in `SET`; it is
 * a module constant re-validated here, never anything a caller supplied.
 */
export function statementTimeoutStatement(): string {
	if (!Number.isInteger(STATEMENT_TIMEOUT_MS) || STATEMENT_TIMEOUT_MS <= 0) {
		fail("statement timeout must be a positive whole number of milliseconds");
	}
	return `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`;
}

/**
 * Run a code-authored statement whose rows are not wanted (`SET LOCAL …`,
 * `SET TRANSACTION READ WRITE`). Goes through `.cursor` like everything else so
 * this module has no simple-protocol call site at all.
 */
async function executeUnit(tx: TransactionSql, statement: string): Promise<void> {
	await tx.unsafe<SqlRow[]>(statement).cursor(1, () => {});
}

/**
 * Run the binding frontend's identity assertion, if it supplied one, inside the
 * open transaction. A frontend-authored message passes through as its own; a
 * driver-shaped failure is redacted like any other.
 */
async function assertIdentity(tx: TransactionSql, hooks: McpToolHooks | undefined): Promise<void> {
	const hook = hooks?.assertIdentity;
	if (hook === undefined) {
		return;
	}
	try {
		await hook(tx);
	} catch (err) {
		const isDriverShaped = typeof fieldOf(err, "code") === "string";
		throw toolHookError(
			!isDriverShaped && err instanceof Error ? err.message : formatSqlError(describeSqlError(err)),
		);
	}
}

/**
 * Open a READ ONLY transaction with the timeout set and the binding frontend's
 * identity assertion run FIRST, then hand the transaction to `body`.
 *
 * Every read tool goes through this — including `listTables` and `describeTable`,
 * which have no caller SQL to guard but must still make their read and the
 * identity assertion share ONE transaction. Under transaction pooling an
 * assertion on a separate round trip proves nothing about the connection the
 * read then lands on.
 */
export async function withReadTransaction<T>(
	sql: Sql,
	hooks: McpToolHooks | undefined,
	body: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
	try {
		// Boxed: postgres.js types `begin`'s result as `UnwrapPromiseArray<T>`, which
		// TypeScript cannot reduce for a naked type parameter. A one-field box is a
		// concrete object type, so the conditional resolves and no assertion is needed.
		const boxed = await sql.begin("read only", async (tx) => {
			await assertIdentity(tx, hooks);
			await executeUnit(tx, statementTimeoutStatement());
			return { value: await body(tx) };
		});
		return boxed.value;
	} catch (err) {
		rethrowRedacted(err);
	}
}

/**
 * The rows the driver parsed but never handed to the cursor callback, if any.
 *
 * `final` is `unknown` on purpose. postgres.js types a resolved cursor as
 * `ExecutionResult<T> = [] & ResultQueryMeta<…>`
 * (`node_modules/postgres/types/index.d.ts:597`) — an EMPTY TUPLE intersected
 * with metadata — while at runtime it is a `Result`, which extends `Array` and
 * holds rows (`node_modules/postgres/src/result.js:1-11`). Indexing the published
 * type is an error, so this narrows through `unknown` with `Array.isArray`
 * instead of asserting.
 *
 * The identity check against `delivered` is the whole point of the helper: when
 * the command tag carries a row count, the driver hands the callback the very
 * object it then resolves with, so returning those rows again would DOUBLE-COUNT
 * the last chunk of every ordinary `SELECT`. The discriminator is object
 * identity, never `count`.
 */
export function residualRows(final: unknown, delivered: readonly SqlRow[] | null): readonly SqlRow[] {
	if (!Array.isArray(final) || final === delivered) {
		return [];
	}
	return final.filter((row): row is SqlRow => typeof row === "object" && row !== null);
}

/**
 * The Postgres command tag off a resolved cursor, or `null` when there is none.
 *
 * Read through `fieldOf` rather than the declared `command: string`, because the
 * type overstates it: an early stop resolves from `CloseComplete`
 * (`node_modules/postgres/src/connection.js:852-855`) before `CommandComplete`
 * has set the tag, so the tag really can be absent.
 */
function commandTag(final: unknown): string | null {
	const command = fieldOf(final, "command");
	return typeof command === "string" && command !== "" ? command : null;
}

/**
 * Execute ONE caller statement inside a READ ONLY transaction with the timeout
 * set, streaming through a cursor and stopping the moment a cap trips.
 *
 * The read-only transaction is a layer, not the boundary — a transaction can be
 * promoted to read-write, which is exactly how `writeSql` works on the same
 * infrastructure. A write submitted here is refused by the ROLE's grants.
 */
export function runReadStatement(
	sql: Sql,
	statement: string,
	budget: RowBudget,
	hooks?: McpToolHooks,
): Promise<ReadExecution> {
	return withReadTransaction(sql, hooks, async (tx) => {
		const accumulator = createRowAccumulator(budget);
		let delivered: readonly SqlRow[] | null = null;
		let stopped = false;
		// The CALLBACK form of `.cursor`, deliberately, and three things depend on it.
		//
		// NOT the async-iterator form: it replaces the query's own resolver with one
		// that throws its argument away (`node_modules/postgres/src/query.js:99`), and
		// that argument is the `Result` holding the final partial chunk. Rows that
		// crossed the wire and were parsed were then discarded inside the driver.
		//
		// NOT `.forEach`, which looks like the simpler fix and is not: `Query.forEach`
		// (`node_modules/postgres/src/query.js:123-127`) does NOT set
		// `options.simple = false` the way `.cursor` does at :75. With a bare
		// `sql.unsafe(text)` that puts the statement back on the SIMPLE query protocol
		// and reopens the stacked-statement execution this module exists to close (see
		// the module header). It also has no way to stop early, so both caps would only
		// apply after the whole result set had crossed the wire.
		const final = await tx.unsafe<SqlRow[]>(statement).cursor(CURSOR_CHUNK_ROWS, (chunk) => {
			delivered = chunk;
			if (accumulator.add(chunk)) {
				return undefined;
			}
			stopped = true;
			// `sql.CLOSE` is the driver's documented stop sentinel
			// (`node_modules/postgres/src/index.js:73`). Returning it takes the same
			// `Close(portal)` path the async iterator's `return()` used, so stopping at
			// a cap is unchanged in timing and in chunk granularity.
			return sql.CLOSE;
		});
		// postgres.js hands the LAST partial chunk to the cursor callback only when the
		// command tag carries a row count (`connection.js:611-614`, `result.count &&
		// query.cursorFn(result)`). Postgres appends a count to `SELECT`, `INSERT`,
		// `UPDATE`, `DELETE`, `MERGE`, `MOVE`, `FETCH` and `COPY` and to nothing else,
		// so utility statements — `EXPLAIN`, `SHOW` — lost their trailing rows entirely
		// while the result still claimed to be complete.
		//
		// `stopped` is required, not defensive: `CloseComplete`
		// (`connection.js:852-855`) also resolves with a row-bearing `Result`, so
		// appending after an early stop could carry the result PAST the cap that
		// stopped it.
		//
		// The residual goes through `accumulator.add` like every other chunk and never
		// straight onto the rows array, so both caps — and any whole-payload accounting
		// the accumulator grows later — apply to it exactly as they do to the rest.
		if (!stopped) {
			accumulator.add(residualRows(final, delivered));
		}
		return { command: commandTag(final), rows: accumulator.rows(), truncatedBy: accumulator.truncatedBy() };
	});
}

/**
 * How many rows the statement really affected, from the command tag and from what
 * the cursor delivered.
 *
 * The tag ALONE is last-chunk-only whenever the statement returned rows: when a
 * portal is resumed, Postgres's `CommandComplete` counts only the rows the LAST
 * `Execute` retrieved, and postgres.js discards each earlier `Result`
 * (`node_modules/postgres/src/connection.js:845`, `result = new Result()` after
 * every `PortalSuspended`), so `result.count` is the size of the final partial
 * chunk rather than the statement's total.
 *
 * `rowsSeen` is every row the cursor callback was handed, INCLUDING the ones a
 * tripped cap declined to keep — which is why bounding the result and repairing
 * this receipt are one change rather than two. Both branches were measured against
 * postgres:17 rather than reasoned about:
 *
 *   - the tag carries no count (`EXPLAIN`, `SHOW`, `CREATE TABLE`) — the answer is
 *     `null` however many rows came back, so a 231-line query plan is never
 *     reported as 231 affected rows;
 *   - the statement returned NO rows (`UPDATE … WHERE` with no `RETURNING`) — the
 *     portal never suspended, so the single `CommandComplete` carries the whole
 *     count and the tag is right. Measured: 250, 5 and 0 each reported exactly.
 *     A 250-row `UPDATE … RETURNING` reported 50, and `rowsSeen` is what corrects it.
 */
function rowsAffected(tagCount: number, rowsSeen: number): number | null {
	if (!Number.isInteger(tagCount)) {
		return null;
	}
	return rowsSeen > 0 ? rowsSeen : tagCount;
}

/**
 * Execute ONE caller statement in a transaction promoted to READ WRITE, with the
 * same single-statement enforcement, the same timeout and the same result caps as
 * a read — but stopping the statement is never how a cap is applied here.
 *
 * The promotion is needed because the role's `default_transaction_read_only` is
 * a DEFAULT, not a lock. It is not what makes the write safe: the write is
 * bounded by what the role has been granted and by nothing in this file.
 */
export async function runWriteStatement(
	sql: Sql,
	statement: string,
	budget: RowBudget,
	hooks?: McpToolHooks,
): Promise<WriteExecution> {
	try {
		return await sql.begin(async (tx) => {
			// The promotion comes first: `SET TRANSACTION` is only legal before the
			// transaction has run a query, and the identity assertion is a query.
			await executeUnit(tx, "SET TRANSACTION READ WRITE");
			await assertIdentity(tx, hooks);
			await executeUnit(tx, statementTimeoutStatement());
			const accumulator = createRowAccumulator(budget);
			let delivered: readonly SqlRow[] | null = null;
			let rowsSeen = 0;
			const result = await tx.unsafe<SqlRow[]>(statement).cursor(CURSOR_CHUNK_ROWS, (chunk) => {
				delivered = chunk;
				rowsSeen += chunk.length;
				// `undefined`, ALWAYS — never `sql.CLOSE`, which is what the read path
				// returns at its cap. The two paths stop differently on purpose. A read
				// has nothing left to finish, so closing its portal costs nothing; closing
				// the portal of an `INSERT … RETURNING` stops the statement MID-EXECUTION
				// and the transaction then commits whatever ran. A caller who asked to
				// insert 10000 rows would get some prefix of them written and a receipt
				// calling the result merely truncated — the worst outcome this change can
				// have, and it is one returned value away.
				//
				// So the callback keeps being called for every remaining chunk, the portal
				// drains, the statement completes and commits exactly once, and the rows
				// past the cap cost only the chunk they arrived in. `add`'s `false` is
				// ignored deliberately: it says "stop KEEPING", not "stop reading".
				accumulator.add(chunk);
				return undefined;
			});
			// The identical lost-last-chunk defect and the identical double-count hazard
			// as the read path: see `runReadStatement` for the mechanism, for why the
			// discriminator is object identity rather than `count`, and for why
			// `.forEach` is not the simpler fix.
			//
			// The residual goes through `accumulator.add` like every other chunk and never
			// straight onto a rows array. Pushing it unguarded past a tripped cap is the
			// specific way a capped result would exceed the budget it just reported. No
			// `stopped` guard is needed the way the read path needs one: nothing stops
			// here, and the accumulator refuses rows past its cap by itself.
			const residual = residualRows(result, delivered);
			rowsSeen += residual.length;
			accumulator.add(residual);
			return {
				command: result.command,
				rowsAffected: rowsAffected(result.count, rowsSeen),
				rows: accumulator.rows(),
				truncatedBy: accumulator.truncatedBy(),
			};
		});
	} catch (err) {
		rethrowRedacted(err);
	}
}
