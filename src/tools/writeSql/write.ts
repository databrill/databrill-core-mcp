/**
 * `writeSql` — ONE caller-authored statement on a connection that is allowed to
 * write, returning a BOUNDED prefix of whatever the statement returned.
 *
 * It shares `../../sqlGuardrails.ts` with the read tools, so the
 * single-statement (extended-protocol) enforcement, the timeout constant and the
 * result caps are literally the same code, not a second implementation that could
 * drift.
 *
 * The caps bound what the statement RETURNS and never what it does. The write
 * role inherits read on every table in the workspace — `UPDATE … WHERE` and
 * `… RETURNING` need those reads — so a plain `SELECT` is valid input here and
 * would otherwise return an unbounded result out of a database that other
 * workspaces are served from. Bounding retention is the answer to that, not
 * inspecting the statement: `runWriteStatement` keeps draining the cursor after a
 * cap trips, so the statement completes and commits exactly once whatever the
 * response looks like.
 *
 * `access: "write"` is DECLARED, and the frontend routes the call from that
 * declaration rather than by matching the tool's name. This tool does not choose
 * its connection any more than the read tools do; if it is handed a read-only
 * connection, its statement is refused by Postgres, which is the correct outcome.
 *
 * The transaction is promoted with `SET TRANSACTION READ WRITE` because the
 * role's `default_transaction_read_only` is a DEFAULT, not a lock. The promotion
 * is NOT what makes the write safe: the write is bounded by what the role has
 * been granted — the config-table prefix and nothing else — and by nothing in
 * this file. No code here inspects the statement to decide whether it may run.
 *
 * See `../executeSql/execute.ts` for why the `mcp-local/CLAUDE.md`
 * feature-origination rule does not apply to this tool family.
 */

import type { Sql } from "postgres";
import type { McpToolHooks } from "../../toolHooks.ts";
import {
	COMMAND_TAG_RESERVE,
	envelopeByteLength,
	MAX_RESULT_BYTES,
	MAX_ROW_LIMIT,
	parseStatement,
	type RowBudget,
	runWriteStatement,
	STATEMENT_TIMEOUT_MS,
	type TruncationCap,
	writeTruncationNotice,
} from "../../sqlGuardrails.ts";
import type { WriteSqlParams, WriteSqlResult } from "./types.ts";

/**
 * The row cap for a write, and why it is the MAXIMUM rather than `executeSql`'s
 * default of 500.
 *
 * 500 is a default there because a caller who needs more can pass a larger `limit`
 * and run the query again. A `writeSql` caller has neither lever: the input schema
 * is one `sql` property by design, and running the statement again would repeat the
 * write. The one answer a write gets is therefore the largest this package returns
 * to anybody.
 */
const WRITE_ROW_LIMIT = MAX_ROW_LIMIT;

/**
 * How much of the byte cap is NOT available to row text, for a write.
 *
 * Derived exactly as `executeSql` derives its own (see `../executeSql/execute.ts`
 * for the reasoning), but over THIS tool's `meta` shape, which carries
 * `rowsAffected` where the read tool carries `limit` and `byteLimit`. It encodes an
 * empty result for every `meta` this call can end up producing — each truncation
 * state, each notice wording — and takes the largest.
 *
 * Two fields are not known before the statement runs: `command`, bounded by the
 * shared `COMMAND_TAG_RESERVE`, and `rowsAffected`, which is the statement's own
 * total and so has no bound of its own — `Number.MAX_SAFE_INTEGER` is the widest
 * number JSON can carry, and costs 16 bytes of 2 MiB.
 *
 * Exported for `tests/unit/sqlGuardrails.test.ts`, which checks the reserve against
 * the envelope this tool really produces. Nothing else calls it.
 */
export function writeEnvelopeReserveBytes(): number {
	const shape: RowBudget = { rowLimit: WRITE_ROW_LIMIT, byteLimit: MAX_RESULT_BYTES, envelopeReserveBytes: 0 };
	const states: readonly (TruncationCap | null)[] = [null, "rows", "bytes"];
	let reserve = 0;
	for (const truncatedBy of states) {
		// 0 and the cap are the two row counts whose notices differ, and the cap is
		// also the widest `returnedRowCount` the result can report.
		for (const returnedRowCount of [0, WRITE_ROW_LIMIT]) {
			reserve = Math.max(
				reserve,
				envelopeByteLength({
					command: COMMAND_TAG_RESERVE,
					rowsAffected: Number.MAX_SAFE_INTEGER,
					returnedRowCount,
					statementTimeoutMs: STATEMENT_TIMEOUT_MS,
					isTruncated: truncatedBy !== null,
					truncatedBy,
					notice: writeTruncationNotice(truncatedBy, shape, returnedRowCount),
				}),
			);
		}
	}
	return reserve;
}

export async function writeSql(params: WriteSqlParams, sql: Sql, hooks?: McpToolHooks): Promise<WriteSqlResult> {
	const statement = parseStatement(params.sql);
	const budget: RowBudget = {
		rowLimit: WRITE_ROW_LIMIT,
		byteLimit: MAX_RESULT_BYTES,
		envelopeReserveBytes: writeEnvelopeReserveBytes(),
	};

	const execution = await runWriteStatement(sql, statement, budget, hooks);
	return {
		meta: {
			command: execution.command,
			rowsAffected: execution.rowsAffected,
			returnedRowCount: execution.rows.length,
			statementTimeoutMs: STATEMENT_TIMEOUT_MS,
			isTruncated: execution.truncatedBy !== null,
			truncatedBy: execution.truncatedBy,
			notice: writeTruncationNotice(execution.truncatedBy, budget, execution.rows.length),
		},
		data: execution.rows,
	};
}
