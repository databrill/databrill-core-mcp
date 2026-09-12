/**
 * `executeSql` — run ONE caller-authored read-only statement against the
 * workspace's own database and return the rows with truncation metadata.
 *
 * Provenance: this tool has NO ported reference implementation, and the
 * feature-origination rule in `mcp-local/CLAUDE.md` (tool logic is ported from a
 * reference in `services/` or the agency repo, with parity as the proof) does not
 * apply to it. That rule exists to protect METRIC logic, where the only proof the
 * math is right is agreement with the reference. There is no metric logic here:
 * `executeSql` is a guarded passthrough of the caller's own SQL, and its
 * siblings `listTables` and `describeTable` are two `information_schema` reads.
 * The missing provenance line is deliberate, not an omission.
 *
 * The tool receives its `Sql` and never opens, selects or reconfigures a
 * connection. Which connection it gets — and therefore whether a write could
 * ever succeed — is decided by the frontend that binds it, from the tool's
 * declared `access` kind. That is the single place where read/write routing is
 * enforceable; four tools each choosing for themselves would not be.
 */

import { Effect, Either } from "effect";
import type { Sql } from "postgres";
import type { McpToolHooks } from "../../toolHooks.ts";
import {
	COMMAND_TAG_RESERVE,
	envelopeByteLength,
	MAX_RESULT_BYTES,
	parseRowLimit,
	type RowBudget,
	runReadStatement,
	STATEMENT_TIMEOUT_MS,
	trimStatement,
	type TruncationCap,
	truncationNotice,
} from "../../sqlGuardrails.ts";
import type { ExecuteSqlParams, ExecuteSqlResult } from "./types.ts";

/**
 * How much of the cap is NOT available to row text, for a call with this row cap.
 *
 * DERIVED, not guessed: it encodes an empty result for every `meta` this call can
 * end up producing — each truncation state, each notice wording, the row count at
 * its widest — and takes the largest. The only field whose length is not known
 * up front is `command`, which `COMMAND_TAG_RESERVE` bounds. Reserving the worst
 * case costs at most a few hundred bytes of 2 MiB, and buys the guarantee that the
 * notice explaining a truncation always fits inside the cap that caused it.
 *
 * Exported for `tests/unit/sqlGuardrails.test.ts`, which checks the reserve against
 * the envelope this tool really produces. Nothing else calls it.
 */
export function envelopeReserveBytes(rowLimit: number): Either.Either<number, Error> {
	return Either.gen(function* () {
		const shape: RowBudget = { rowLimit, byteLimit: MAX_RESULT_BYTES, envelopeReserveBytes: 0 };
		const states: readonly (TruncationCap | null)[] = [null, "rows", "bytes"];
		let reserve = 0;
		for (const truncatedBy of states) {
			// 0 and `rowLimit` are the two row counts whose notices differ, and
			// `rowLimit` is also the widest `rowCount` the result can report.
			for (const rowCount of [0, rowLimit]) {
				reserve = Math.max(
					reserve,
					yield* envelopeByteLength({
						command: COMMAND_TAG_RESERVE,
						rowCount,
						limit: rowLimit,
						byteLimit: MAX_RESULT_BYTES,
						statementTimeoutMs: STATEMENT_TIMEOUT_MS,
						isTruncated: truncatedBy !== null,
						truncatedBy,
						notice: truncationNotice(truncatedBy, shape, rowCount),
					}),
				);
			}
		}
		return reserve;
	});
}

export function executeSql(
	params: ExecuteSqlParams,
	sql: Sql,
	hooks?: McpToolHooks,
): Effect.Effect<ExecuteSqlResult, Error> {
	return Effect.gen(function* () {
		const statement = yield* trimStatement(params.sql);
		const rowLimit = yield* parseRowLimit(params.limit);
		const budget: RowBudget = {
			rowLimit,
			byteLimit: MAX_RESULT_BYTES,
			envelopeReserveBytes: yield* envelopeReserveBytes(rowLimit),
		};

		const execution = yield* runReadStatement(sql, statement, budget, hooks);
		return {
			meta: {
				command: execution.command,
				rowCount: execution.rows.length,
				limit: budget.rowLimit,
				byteLimit: budget.byteLimit,
				statementTimeoutMs: STATEMENT_TIMEOUT_MS,
				isTruncated: execution.truncatedBy !== null,
				truncatedBy: execution.truncatedBy,
				notice: truncationNotice(execution.truncatedBy, budget, execution.rows.length),
			},
			data: execution.rows,
		};
	});
}
