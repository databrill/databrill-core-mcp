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

/** Default and maximum row caps, mirroring the `loadTflInventory` precedent. */
export const DEFAULT_ROW_LIMIT = 500;
export const MAX_ROW_LIMIT = 1000;

/** Serialized-JSON byte cap: 2 MiB. */
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;

/** Rows fetched per cursor round trip. Bounds memory without a round trip per row. */
const CURSOR_CHUNK_ROWS = 100;

/**
 * What an unrecoverable non-Postgres failure is reported as. Driver-level errors
 * carry the host and port in their message (`write CONNECTION_CLOSED host:port`),
 * so their text NEVER reaches the client.
 */
const OPAQUE_FAILURE = "The database connection failed before the statement completed.";

export interface RowBudget {
	readonly rowLimit: number;
	readonly byteLimit: number;
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
	/** Rows affected as Postgres reported them, or `null` for commands with no count. */
	readonly rowsAffected: number | null;
	/** Rows produced by a `RETURNING` clause, if any. */
	readonly rows: readonly SqlRow[];
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

function serializedByteLength(row: SqlRow): number {
	return encoder.encode(JSON.stringify(row)).length;
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
 */
export function createRowAccumulator(budget: RowBudget): RowAccumulator {
	const rows: SqlRow[] = [];
	let bytes = 0;
	let truncatedBy: TruncationCap | null = null;

	return {
		add(chunk) {
			for (const row of chunk) {
				if (rows.length >= budget.rowLimit) {
					truncatedBy = "rows";
					return false;
				}
				const rowBytes = serializedByteLength(row);
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
			return `The first row alone exceeded the ${budget.byteLimit}-byte serialized-JSON cap, ` +
				"so no rows are returned. Project fewer or narrower columns from that one row, or — " +
				"for a query plan — use EXPLAIN without FORMAT JSON, which returns one row per plan line.";
		}
		return `Truncated at the ${budget.byteLimit}-byte serialized-JSON cap before the ` +
			`${budget.rowLimit}-row cap: more rows match. Select fewer or narrower columns.`;
	}
	return null;
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
 * Execute ONE caller statement in a transaction promoted to READ WRITE, with the
 * same single-statement enforcement and the same timeout, and NO row cap.
 *
 * The promotion is needed because the role's `default_transaction_read_only` is
 * a DEFAULT, not a lock. It is not what makes the write safe: the write is
 * bounded by what the role has been granted and by nothing in this file.
 */
export async function runWriteStatement(
	sql: Sql,
	statement: string,
	hooks?: McpToolHooks,
): Promise<WriteExecution> {
	try {
		return await sql.begin(async (tx) => {
			// The promotion comes first: `SET TRANSACTION` is only legal before the
			// transaction has run a query, and the identity assertion is a query.
			await executeUnit(tx, "SET TRANSACTION READ WRITE");
			await assertIdentity(tx, hooks);
			await executeUnit(tx, statementTimeoutStatement());
			const rows: SqlRow[] = [];
			let delivered: readonly SqlRow[] | null = null;
			const result = await tx.unsafe<SqlRow[]>(statement).cursor(CURSOR_CHUNK_ROWS, (chunk) => {
				delivered = chunk;
				rows.push(...chunk);
			});
			// The identical lost-last-chunk defect and the identical double-count hazard
			// as the read path: see `runReadStatement` for the mechanism, for why the
			// discriminator is object identity rather than `count`, and for why
			// `.forEach` is not the simpler fix. There is no cap on this path, so the
			// callback never returns `sql.CLOSE` and no `stopped` guard is needed — but
			// the residual still goes onto `rows` through the same push the chunks take,
			// never by a second route.
			rows.push(...residualRows(result, delivered));
			return {
				command: result.command,
				// LAST-CHUNK-ONLY, so an UNDERCOUNT for any statement whose rows spanned
				// more than one cursor chunk: a 100-row `INSERT … RETURNING` reports 0 and
				// a 101-row one reports 1 (measured, not theorised). When a portal is
				// resumed, Postgres's `CommandComplete` tag counts only the rows the LAST
				// `Execute` retrieved, and postgres.js discards each earlier `Result`
				// (`connection.js:845`, `result = new Result()` after every
				// `PortalSuspended`), so `result.count` is the size of the final partial
				// chunk rather than the statement's total. Deliberately NOT repaired here:
				// choosing between the tag's count and `rows.length` changes what the
				// receipt MEANS for a `RETURNING` statement, and this change is only about
				// not dropping rows. `meta.returnedRowCount` is trustworthy in the meantime.
				rowsAffected: Number.isInteger(result.count) ? result.count : null,
				rows,
			};
		});
	} catch (err) {
		rethrowRedacted(err);
	}
}
