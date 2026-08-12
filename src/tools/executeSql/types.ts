import type { SqlRow, TruncationCap } from "../../sqlGuardrails.ts";

export interface ExecuteSqlParams {
	readonly sql?: string | undefined;
	readonly limit?: number | undefined;
}

export interface ExecuteSqlResult {
	readonly meta: {
		readonly rowCount: number;
		/** The effective row cap for this call (the request's, or the default). */
		readonly limit: number;
		readonly byteLimit: number;
		readonly statementTimeoutMs: number;
		readonly isTruncated: boolean;
		/** Which cap truncated the result, or `null` when it is complete. */
		readonly truncatedBy: TruncationCap | null;
		/** Human-readable truncation notice, or `null` when the result is complete. */
		readonly notice: string | null;
	};
	readonly data: readonly SqlRow[];
}
