/**
 * loadRank — BSR (Best Sellers Rank) trend per ASIN over a window. Generalized
 * from the original single-client `queryBsrTrend`: the rank table is per-marketplace
 * (`amazon_sales_rank__{cc}`), so we pick the table(s) for the resolved
 * countries and resolve numeric subcategory codes to names via
 * `amazon_browse_node` keyed on that country's marketplace_code.
 *
 * One row per (asin, category, day). The rank table can hold several snapshots
 * of one ASIN and category on one day; the latest of each day is kept, with its
 * time as `observedAt`, so every day weighs the same and every rank returned is
 * one Amazon reported. The day is the marketplace's local calendar day, from its
 * time zone in `amazonConstants.ts`, and the `when` window selects those days.
 *
 * A numeric category key is a browse-node subcategory, named from
 * `amazon_browse_node` where that table exists; any other key is a top-level
 * department, which that table does not name, so its key is its `categoryName`.
 */
import { type ProductSelection, resolveProductsForStores } from "../../productSelection.ts";
import { Effect, Result } from "effect";
import { tryPromiseOrOperationError } from "../../effectErrors.ts";
import postgres from "postgres";
import { createCanonicalQueryBuilder } from "@jsr/databrill__core-pg-kysely/canonical";
import { marketplaceIdToMarketplaceInfo } from "../../amazonConstants.ts";
import { runCompiled } from "../../runCompiled.ts";
import { resolveStores, resolveWhen } from "../loadAds/loadAds.ts";
import type { LoadRankParams, LoadRankResult, RankCategoryKind, RankPoint } from "./types.ts";

function fail(msg: string): Result.Result<never, Error> {
	return Result.fail(new Error(msg));
}

/** A numeric browse-node key is a subcategory; any other key is a top-level department. */
function categoryKindOf(category: string): RankCategoryKind {
	return /^\d+$/.test(category) ? "subcategory" : "department";
}

export function loadRank(params: LoadRankParams, sql: postgres.Sql): Effect.Effect<LoadRankResult, Error> {
	return Effect.gen(function* () {
		if (!params.stores) return yield* Effect.fromResult(fail("stores is required"));
		if (!params.when) return yield* Effect.fromResult(fail("when is required"));

		const stores = yield* resolveStores(params.stores, sql);
		const countries = [...new Set(stores.map((s) => s.countryCode))]; // uppercase, e.g. DE
		// Every store of a country is in that country's marketplace.
		const marketplaceIdByCountry = new Map(stores.map((s) => [s.countryCode, s.marketplaceId]));
		const range = yield* resolveWhen(params.when, sql);

		let asins: ProductSelection | null = null;
		if (params.products) {
			asins = yield* resolveProductsForStores(params.products, sql, stores);
			if (asins.size === 0) return yield* Effect.fromResult(fail("products resolved to zero ASINs"));
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
			const marketplaceId = marketplaceIdByCountry.get(country) ?? country;
			const tz = marketplaceIdToMarketplaceInfo[marketplaceId]?.timeZone;
			if (tz === undefined) {
				return yield* Effect.fromResult(fail(`No time zone is known for marketplace ${marketplaceId}`));
			}
			present.push(country);

			// The day is computed once in the subquery, so DISTINCT ON and ORDER BY name a
			// column rather than repeating an expression with its own time-zone parameter,
			// which would not match. The range predicate stays on the raw "time" column so
			// its index and partition pruning apply: local midnight of the first day up to
			// local midnight after the last, as UTC instants.
			const selectedAsins = asins?.get(marketplaceId);
			const asinFilter = asins === null ? sql`` : sql`AND asin = ANY(${[...(selectedAsins ?? [])]}::text[])`;
			const rows = yield* tryPromiseOrOperationError(() =>
				sql<Array<{ asin: string; category: string; rank: number; date: string; observedAt: string }>>`
			SELECT DISTINCT ON (asin, category, day)
				asin, category, rank, day::text AS date, observed_at AS "observedAt"
			FROM (
				SELECT asin, category, rank, "time",
					("time" AT TIME ZONE ${tz})::date AS day,
					to_char("time" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS observed_at
				FROM ${sql(table)}
				WHERE "time" >= (${range.dateFirst}::date)::timestamp AT TIME ZONE ${tz}
					AND "time" < (${range.dateLast}::date + 1)::timestamp AT TIME ZONE ${tz}
					${asinFilter}
			) s
			ORDER BY asin, category, day, "time" DESC
		`
			).pipe(Effect.uninterruptible);

			// Resolve numeric subcategory codes → display names for this marketplace.
			const numeric = [
				...new Set(
					rows.map((r) => String(r.category)).filter((c) => categoryKindOf(c) === "subcategory"),
				),
			];
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
				const categoryKind = categoryKindOf(category);
				data.push({
					country,
					asin: r.asin,
					date: r.date,
					observedAt: r.observedAt,
					rank: Number(r.rank),
					category,
					categoryKind,
					categoryName: categoryKind === "subcategory"
						? nameMap.get(category) ?? `subcategory ${category}`
						: category,
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
