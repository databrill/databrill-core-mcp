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
 * learns the ceiling instead of quietly receiving less than it asked for.
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

/** The notice that tells an agent "there is more" and WHICH cap stopped the read. */
export function truncationNotice(truncatedBy: TruncationCap | null, budget: RowBudget): string | null {
	if (truncatedBy === "rows") {
		return `Truncated at the ${budget.rowLimit}-row cap: more rows match. ` +
			`Narrow the query, aggregate, or raise limit (maximum ${MAX_ROW_LIMIT}).`;
	}
	if (truncatedBy === "bytes") {
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
		for await (const chunk of tx.unsafe<SqlRow[]>(statement).cursor(CURSOR_CHUNK_ROWS)) {
			if (!accumulator.add(chunk)) {
				break;
			}
		}
		return { rows: accumulator.rows(), truncatedBy: accumulator.truncatedBy() };
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
			const result = await tx.unsafe<SqlRow[]>(statement).cursor(CURSOR_CHUNK_ROWS, (chunk) => {
				rows.push(...chunk);
			});
			return {
				command: result.command,
				rowsAffected: Number.isInteger(result.count) ? result.count : null,
				rows,
			};
		});
	} catch (err) {
		rethrowRedacted(err);
	}
}
