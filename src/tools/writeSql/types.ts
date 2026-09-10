import type { SqlRow, TruncationCap } from "../../sqlGuardrails.ts";

export interface WriteSqlParams {
	readonly sql?: string | undefined;
}

export interface WriteSqlResult {
	readonly meta: {
		/** The Postgres command tag (`INSERT`, `UPDATE`, `DELETE`, …). */
		readonly command: string;
		/**
		 * How many rows the statement AFFECTED, or `null` for a command whose tag
		 * carries no count (`EXPLAIN`, `SHOW`, `CREATE TABLE`). This is the whole
		 * total, never the number returned: when a cap truncates the result, this
		 * field is how the caller learns how much it did not receive.
		 */
		readonly rowsAffected: number | null;
		/**
		 * How many `RETURNING` rows came back. A cap can hold this below
		 * `rowsAffected`; it never holds back the write itself.
		 */
		readonly returnedRowCount: number;
		readonly statementTimeoutMs: number;
		readonly isTruncated: boolean;
		/** Which cap truncated the returned rows, or `null` when they all fit. */
		readonly truncatedBy: TruncationCap | null;
		/**
		 * Human-readable truncation notice, or `null` when nothing was truncated.
		 * Unlike `executeSql`'s, it never advises running the statement again — that
		 * would repeat the write — and names `executeSql` as the way to read the rest.
		 */
		readonly notice: string | null;
	};
	readonly data: readonly SqlRow[];
}
