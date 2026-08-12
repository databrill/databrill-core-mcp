/**
 * `writeSql` — ONE caller-authored statement on a connection that is allowed to
 * write, with no row cap.
 *
 * It shares `../../sqlGuardrails.ts` with the read tools, so the
 * single-statement (extended-protocol) enforcement and the timeout constant are
 * literally the same code, not a second implementation that could drift.
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
import { parseStatement, runWriteStatement, STATEMENT_TIMEOUT_MS } from "../../sqlGuardrails.ts";
import type { WriteSqlParams, WriteSqlResult } from "./types.ts";

export async function writeSql(params: WriteSqlParams, sql: Sql, hooks?: McpToolHooks): Promise<WriteSqlResult> {
	const statement = parseStatement(params.sql);

	const execution = await runWriteStatement(sql, statement, hooks);
	return {
		meta: {
			command: execution.command,
			rowsAffected: execution.rowsAffected,
			returnedRowCount: execution.rows.length,
			statementTimeoutMs: STATEMENT_TIMEOUT_MS,
		},
		data: execution.rows,
	};
}
