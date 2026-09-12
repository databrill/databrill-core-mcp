/**
 * loadRank — BSR (Best Sellers Rank) trend per ASIN over a window. Generalized
 * from the original single-client `queryBsrTrend`: the rank table is per-marketplace
 * (`amazon_sales_rank__{cc}`), so we pick the table(s) for the resolved
 * countries and resolve numeric subcategory codes to names via
 * `amazon_browse_node` keyed on that country's marketplace_code.
 */

import { Effect, Either } from "effect";
import { tryPromiseOrOperationError } from "../../effectErrors.ts";
import postgres from "postgres";
import { createCanonicalQueryBuilder } from "@jsr/databrill__core-pg-kysely/canonical";
import { runCompiled } from "../../runCompiled.ts";
import { resolveProducts, resolveStores, resolveWhen } from "../loadAds/loadAds.ts";
import type { LoadRankParams, LoadRankResult, RankPoint } from "./types.ts";

function fail(msg: string): Either.Either<never, Error> {
	return Either.left(new Error(msg));
}

export function loadRank(params: LoadRankParams, sql: postgres.Sql): Effect.Effect<LoadRankResult, Error> {
	return Effect.gen(function* () {
		if (!params.stores) return yield* fail("stores is required");
		if (!params.when) return yield* fail("when is required");

		const stores = yield* resolveStores(params.stores, sql);
		const countries = [...new Set(stores.map((s) => s.countryCode))]; // uppercase, e.g. DE
		const range = yield* resolveWhen(params.when, sql);

		let asins: string[] | null = null;
		if (params.products) {
			asins = yield* resolveProducts(params.products, sql);
			if (asins.length === 0) return yield* fail("products resolved to zero ASINs");
		}

		// Which per-marketplace rank tables actually exist?
		// These direct driver calls cannot be cancelled; finish each before releasing the connection.
		const wanted = countries.map((c) => `amazon_sales_rank__${c.toLowerCase()}`);
		const existRows = yield* tryPromiseOrOperationError(() =>
			sql<Array<{ table_name: string }>>`
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = ANY(current_schemas(false)) AND table_name IN ${sql(wanted)}
	`
		).pipe(Effect.uninterruptible);
		const existing = new Set(existRows.map((r) => r.table_name));

		// Subcategory names come from amazon_browse_node, which not every client DB
		// has — resolve names only when it's present, else fall back to the code.
		const browseRows = yield* tryPromiseOrOperationError(() =>
			sql<Array<{ exists: boolean }>>`
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = ANY(current_schemas(false)) AND table_name = 'amazon_browse_node'
		) AS exists
	`
		).pipe(Effect.uninterruptible);
		const hasBrowseNode = browseRows[0]?.exists === true;

		// One builder for the whole invocation: it is where a future
		// `.withSchema(workspaceSchema)` would attach.
		const db = createCanonicalQueryBuilder();

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
			const rows = yield* tryPromiseOrOperationError(() =>
				sql<Array<{ asin: string; category: string; rank: number; date: string }>>`
			SELECT asin, category, rank, time::date::text AS date
			FROM ${sql(table)}
			WHERE time::date >= ${range.dateFirst}::date
				AND time::date <= ${range.dateLast}::date
				${asinFilter}
			ORDER BY asin, time
		`
			).pipe(Effect.uninterruptible);

			// Resolve numeric subcategory codes → display names for this marketplace.
			const numeric = [...new Set(rows.map((r) => String(r.category)).filter((c) => /^\d+$/.test(c)))];
			const nameMap = new Map<string, string>();
			if (hasBrowseNode && numeric.length > 0) {
				// The digit STRINGS are bound, not `Number(...)`: `amazon_browse_node.id`
				// is `int8`, whose select type is `string`, so a `number[]` operand does
				// not type-check. Nothing changes on the wire — postgres.js infers OID 0
				// (unspecified) for both a number and a string, and Postgres resolves it
				// against the `int8` column either way.
				const nameRows = yield* runCompiled(
					sql,
					() =>
						db
							.selectFrom("amazon_browse_node")
							.select((eb) => [eb.cast<string>(eb.ref("id"), "text").as("id"), "name"])
							.where("marketplace_code", "=", country)
							.where("id", "in", numeric)
							.compile(),
				);
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
	});
}
