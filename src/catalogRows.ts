import { type RawBuilder, sql } from "kysely";

/** One catalog row per ASIN/country. GB wins over UK, even when its parent is null. */
export const CATALOG_ROWS_SQL = `
SELECT DISTINCT ON (asin, CASE WHEN marketplace_code = 'UK' THEN 'GB' ELSE marketplace_code END)
  c.*, CASE WHEN marketplace_code = 'UK' THEN 'GB' ELSE marketplace_code END AS country
FROM "amzspapi_catalog_items_v20220401__catalogitem" c
ORDER BY asin, CASE WHEN marketplace_code = 'UK' THEN 'GB' ELSE marketplace_code END, marketplace_code`;

/** The same selection for queries compiled by Kysely. */
export function catalogRows(): RawBuilder<{
	readonly asin: string;
	readonly country: string;
	readonly parent_asin: string | null;
}> {
	return sql`(${sql.raw(CATALOG_ROWS_SQL)})`;
}
