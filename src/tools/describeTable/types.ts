export interface TableColumn {
	readonly position: number;
	readonly name: string;
	readonly dataType: string;
	readonly isNullable: boolean;
	readonly columnDefault: string | null;
}

export interface DescribeTableParams {
	readonly table?: string | undefined;
}

export interface DescribeTableResult {
	readonly meta: {
		readonly table: string;
		/** The schema the table was found in, or `null` when it was not found. */
		readonly schema: string | null;
		/** The effective schema search list the lookup was scoped to. */
		readonly schemas: readonly string[];
		readonly exists: boolean;
		readonly columnCount: number;
	};
	readonly data: readonly TableColumn[];
}
