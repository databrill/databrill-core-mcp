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
 * declared `access` kind. That is the single seam where read/write routing is
 * enforceable; four tools each choosing for themselves would not be.
 */

import type { Sql } from "postgres";
import type { McpToolHooks } from "../../toolHooks.ts";
import {
	MAX_RESULT_BYTES,
	parseRowLimit,
	parseStatement,
	type RowBudget,
	runReadStatement,
	STATEMENT_TIMEOUT_MS,
	truncationNotice,
} from "../../sqlGuardrails.ts";
import type { ExecuteSqlParams, ExecuteSqlResult } from "./types.ts";

export async function executeSql(
	params: ExecuteSqlParams,
	sql: Sql,
	hooks?: McpToolHooks,
): Promise<ExecuteSqlResult> {
	const statement = parseStatement(params.sql);
	const budget: RowBudget = { rowLimit: parseRowLimit(params.limit), byteLimit: MAX_RESULT_BYTES };

	const execution = await runReadStatement(sql, statement, budget, hooks);
	return {
		meta: {
			rowCount: execution.rows.length,
			limit: budget.rowLimit,
			byteLimit: budget.byteLimit,
			statementTimeoutMs: STATEMENT_TIMEOUT_MS,
			isTruncated: execution.truncatedBy !== null,
			truncatedBy: execution.truncatedBy,
			notice: truncationNotice(execution.truncatedBy, budget),
		},
		data: execution.rows,
	};
}
