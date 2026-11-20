import { createCanonicalQueryBuilder, probeRelations } from "@jsr/databrill__core-pg-kysely/canonical";
import { runCompiled } from "./runCompiled.ts";
import { catalogRows } from "./catalogRows.ts";
import { Effect } from "effect";
import type { Expression, RawBuilder, SqlBool } from "kysely";
import { sql as ksql } from "kysely";
import type { Sql } from "postgres";
import type { ResolvedStore } from "./tools/loadAds/loadAds.ts";

/** Each marketplace retains its own expanded children through the source read. */
export type ProductSelection = ReadonlyMap<string, readonly string[]>;

/** Resolve literal ASINs, local parent ASINs and configured families for each selected marketplace. */
export function resolveProductsForStores(
	products: string,
	sql: Sql,
	stores: readonly ResolvedStore[],
	options?: { readonly warnOnMissingFamily?: boolean },
): Effect.Effect<ProductSelection, Error> {
	return Effect.gen(function* () {
		const selections = new Map<string, readonly string[]>();
		for (const store of new Map(stores.map((store) => [store.marketplaceId, store])).values()) {
			const asins = yield* resolveProducts(products, sql, { ...options, country: store.countryCode });
			if (asins.length > 0) {
				selections.set(store.marketplaceId, asins);
			}
		}
		return selections;
	});
}

/** Apply the product list and its marketplace together, including an empty selection. */
export function productSelectionPredicate(
	products: ProductSelection,
	asin: Expression<string | null>,
	marketplace: Expression<string>,
): RawBuilder<SqlBool> {
	const choices = [...products].map(([id, asins]) =>
		ksql`(${marketplace} = ${id} AND ${asin} IN (${ksql.join(asins)}))`
	);
	return choices.length === 0 ? ksql`false` : ksql`(${ksql.join(choices, ksql` OR `)})`;
}

// A book ASIN is an ISBN-10: nine digits and a check digit that can be X.
const ASIN_PATTERN = /^(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$/i;

/** Resolve tokens using the selected country's catalog row; families remain workspace-wide. */
export function resolveProducts(
	productsStr: string,
	sql: Sql,
	options: { readonly country: string | null; readonly warnOnMissingFamily?: boolean },
): Effect.Effect<string[], Error> {
	return Effect.gen(function* () {
		const db = createCanonicalQueryBuilder();
		const tokens = productsStr.split(",").map((s) => s.trim()).filter(Boolean);
		const childAsins = new Set<string>();
		// Only a family-name token reads the family table, so only then is it probed.
		const familyTable = tokens.some((token) => !ASIN_PATTERN.test(token))
			? (yield* probeRelations(db, sql, ["brand_config_amazon_asin"])).has("brand_config_amazon_asin")
			: false;

		for (const token of tokens) {
			if (ASIN_PATTERN.test(token)) {
				// Check if parent ASIN -> expand to children
				const children = options.country === null ? [] : yield* runCompiled(
					sql,
					() =>
						db
							.selectFrom(catalogRows().as("catalog"))
							.select("asin")
							.where("country", "=", options.country)
							.where("parent_asin", "=", token)
							.compile(),
				);
				if (children.length > 0) {
					for (const row of children) childAsins.add(row.asin);
				} else {
					// Treat as child ASIN directly
					childAsins.add(token);
				}
			} else {
				// Family name lookup
				const rows = familyTable
					? yield* runCompiled(
						sql,
						() =>
							db.selectFrom("brand_config_amazon_asin").select("asin").where("family", "=", token)
								.compile(),
					)
					: [];
				if (rows.length === 0 && options.warnOnMissingFamily !== false) {
					console.error(`Warning: no ASINs found for family '${token}'`);
				}
				for (const row of rows) childAsins.add(row.asin);
			}
		}

		return [...childAsins];
	});
}
