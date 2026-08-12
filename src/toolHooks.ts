/**
 * Per-call hooks a binding frontend may supply to a tool.
 *
 * Its own module rather than `contract.ts` so `sqlGuardrails.ts`
 * can depend on the hook shape without importing the tool registry that imports
 * it back.
 */

import type { TransactionSql } from "postgres";

export interface McpToolHooks {
	/**
	 * Run as the FIRST statement inside the tool's own transaction, to confirm the
	 * connection is the one the caller was routed to before the caller's statement
	 * runs on it. It throws to abort the call.
	 *
	 * It exists because the transaction is opened HERE but only the binding frontend
	 * knows what identity to expect; mcp-local must not learn the hosted `w{wsid}`
	 * schema/role convention. Frontends with one connection pass nothing and this is
	 * a no-op.
	 *
	 * The parameter is `TransactionSql`, not `Sql`: the hook is handed the open
	 * transaction, which is the whole point — an assertion on a different connection
	 * would prove nothing under transaction pooling — and postgres.js's
	 * `TransactionSql` is not assignable to `Sql`.
	 */
	readonly assertIdentity?: (sql: TransactionSql) => Promise<void>;
}
