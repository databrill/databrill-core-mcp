import type { SqlRow } from "../../sqlGuardrails.ts";

export interface WriteSqlParams {
	readonly sql?: string | undefined;
}

export interface WriteSqlResult {
	readonly meta: {
		/** The Postgres command tag (`INSERT`, `UPDATE`, `DELETE`, …). */
		readonly command: string;
		/** Rows affected as Postgres reported them, or `null` for commands with no count. */
		readonly rowsAffected: number | null;
		/** Rows produced by a `RETURNING` clause. No row cap applies to a write. */
		readonly returnedRowCount: number;
		readonly statementTimeoutMs: number;
	};
	readonly data: readonly SqlRow[];
}
