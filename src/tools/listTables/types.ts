export interface ListedTable {
	readonly schema: string;
	readonly name: string;
	/** `BASE TABLE`, `VIEW`, … as `information_schema` reports it. */
	readonly type: string;
}

export interface ListTablesResult {
	readonly meta: {
		/** The effective schema search list this listing was scoped to. */
		readonly schemas: readonly string[];
		readonly tableCount: number;
	};
	readonly data: readonly ListedTable[];
}
