/**
 * loadRank — BSR (Best Sellers Rank) trend per ASIN over a window. Generalized
 * from the original single-client `queryBsrTrend`: the rank table is per-marketplace
 * (`amazon_sales_rank__{cc}`), so we pick the table(s) for the resolved
 * countries and resolve numeric subcategory codes to names via
 * `amazon_browse_node` keyed on that country's marketplace_code.
 */

import postgres from "postgres";
import { resolveProducts, resolveStores, resolveWhen } from "../loadAds/loadAds.ts";
import type { LoadRankParams, LoadRankResult, RankPoint } from "./types.ts";

function fail(msg: string): never {
	throw new Error(msg);
}

export async function loadRank(params: LoadRankParams, sql: postgres.Sql): Promise<LoadRankResult> {
	if (!params.stores) fail("stores is required");
	if (!params.when) fail("when is required");

	const stores = await resolveStores(params.stores, sql);
	const countries = [...new Set(stores.map((s) => s.countryCode))]; // uppercase, e.g. DE
	const range = await resolveWhen(params.when, sql);

	let asins: string[] | null = null;
	if (params.products) {
		asins = await resolveProducts(params.products, sql);
		if (asins.length === 0) fail("products resolved to zero ASINs");
	}

	// Which per-marketplace rank tables actually exist?
	const wanted = countries.map((c) => `amazon_sales_rank__${c.toLowerCase()}`);
	const existRows = await sql<Array<{ table_name: string }>>`
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = ANY(current_schemas(false)) AND table_name IN ${sql(wanted)}
	`;
	const existing = new Set(existRows.map((r) => r.table_name));

	// Subcategory names come from amazon_browse_node, which not every client DB
	// has — resolve names only when it's present, else fall back to the code.
	const browseRows = await sql<Array<{ exists: boolean }>>`
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = ANY(current_schemas(false)) AND table_name = 'amazon_browse_node'
		) AS exists
	`;
	const hasBrowseNode = browseRows[0]?.exists === true;

	const data: RankPoint[] = [];
	const present: string[] = [];
	const missing: string[] = [];

	for (const country of countries) {
		const table = `amazon_sales_rank__${country.toLowerCase()}`;
		if (!existing.has(table)) {
			missing.push(country);
			continue;
		}
		present.push(country);

		const asinFilter = asins ? sql`AND asin IN ${sql(asins)}` : sql``;
		const rows = await sql<Array<{ asin: string; category: string; rank: number; date: string }>>`
			SELECT asin, category, rank, time::date::text AS date
			FROM ${sql(table)}
			WHERE time::date >= ${range.dateFirst}::date
				AND time::date <= ${range.dateLast}::date
				${asinFilter}
			ORDER BY asin, time
		`;

		// Resolve numeric subcategory codes → display names for this marketplace.
		const numeric = [...new Set(rows.map((r) => String(r.category)).filter((c) => /^\d+$/.test(c)))];
		const nameMap = new Map<string, string>();
		if (hasBrowseNode && numeric.length > 0) {
			const ids = numeric.map((c) => Number(c));
			const nameRows = await sql<Array<{ id: string; name: string }>>`
				SELECT id::text AS id, name FROM amazon_browse_node
				WHERE marketplace_code = ${country} AND id IN ${sql(ids)}
			`;
			for (const nr of nameRows) nameMap.set(nr.id, nr.name);
		}

		for (const r of rows) {
			const category = String(r.category);
			data.push({
				country,
				asin: r.asin,
				date: r.date,
				rank: Number(r.rank),
				category,
				categoryName: nameMap.get(category) ?? `subcategory ${category}`,
			});
		}
	}

	return {
		meta: {
			dateFirst: range.dateFirst,
			dateLast: range.dateLast,
			stores: present,
			missingRankTables: missing,
			rowCount: data.length,
		},
		data,
	};
}
