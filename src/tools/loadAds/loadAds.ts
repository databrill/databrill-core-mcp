import { Effect, Either } from "effect";
import { tryOrOperationError } from "../../effectErrors.ts";
import type postgres from "postgres";
import { Schema } from "effect";
import { createCanonicalQueryBuilder, probeRelations } from "@jsr/databrill__core-pg-kysely/canonical";
import {
	type AliasedExpression,
	type Expression,
	expressionBuilder,
	type ExpressionWrapper,
	type RawBuilder,
	sql as ksql,
} from "kysely";
import {
	type AmazonMarketplaceInfo,
	countryCodeToMarketplaceInfo,
	marketplaceIdToMarketplaceInfo,
	regionCountryCodes,
} from "../../amazonConstants.ts";
import { parseWhenAst, type WhenAst_Duration } from "../../parseWhenAst.ts";
import { boundTrue, isoDateParam, runCompiled } from "../../runCompiled.ts";
import { jsonbText } from "../../sqlJson.ts";

/**
 * The canonical query builder's own type, derived from its factory.
 *
 * `src/` may not import the generated `DB` interface (the boundary scan in
 * `tests/unit/` rejects a `../services` or `@databrill/` specifier), and the
 * canonical entry point does not export it, so a function that takes the builder
 * as a parameter names it this way.
 */
type CanonicalDb = ReturnType<typeof createCanonicalQueryBuilder>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedStore {
	merchantId: string;
	merchantName: string; // seller account name from amazon_store
	marketplaceId: string;
	countryCode: string;
	currency: string;
	storeName: string; // marketplace storefront label, e.g. "Amazon.de"
}

export interface DateRange {
	readonly dateFirst: string; // YYYY-MM-DD inclusive
	readonly dateLast: string; // YYYY-MM-DD inclusive
}

export type ParsedWhenRange =
	| { readonly kind: "explicit"; readonly range: DateRange }
	| { readonly kind: "trailing"; readonly duration: WhenAst_Duration };

export interface FilterExpr {
	field: string;
	op: string;
	value: string;
}

export const VALID_GROUP_BY = [
	"asin",
	"family",
	"parentAsin",
	"campaign",
	"adType",
	"placement",
	"target",
	"adgroup",
	"country",
	"store",
	"merchant",
	"marketplaceId",
] as const;
export type GroupByDim = typeof VALID_GROUP_BY[number];

export const VALID_TIME_UNITS = ["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"] as const;
export type TimeUnit = typeof VALID_TIME_UNITS[number];

// A regular ASIN, or a book ASIN: Amazon uses the ISBN-10 (nine digits and a
// check digit that may be `X`) as the ASIN of a book listing.
const ASIN_PATTERN = /^(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$/i;
const UNRESOLVED_ASIN = "B0000000000";

// ---------------------------------------------------------------------------
// Input schema for --input JSON
// ---------------------------------------------------------------------------

export const LoadAdsInputSchema = Schema.Struct({
	stores: Schema.String,
	when: Schema.String,
	groupBy: Schema.String,
	timeUnit: Schema.optional(Schema.String),
	products: Schema.optional(Schema.String),
	filter: Schema.optional(Schema.String),
	derived: Schema.optional(Schema.Boolean),
	nested: Schema.optional(Schema.Boolean),
});

export type LoadAdsInput = typeof LoadAdsInputSchema.Type;

// ---------------------------------------------------------------------------
// Params accepted by loadAds()
// ---------------------------------------------------------------------------

export interface LoadAdsParams {
	stores: string;
	when: string;
	groupBy: string;
	timeUnit?: string | undefined;
	products?: string | undefined;
	filter?: string | undefined;
	format?: string | undefined;
	derived?: boolean | undefined;
	nested?: boolean | undefined;
}

export interface LoadAdsResult {
	meta: {
		dateFirst: string;
		dateLast: string;
		stores: string[];
		dateDataLatest: string;
		rowCount: number;
		groupBy: GroupByDim[];
		timeUnit: TimeUnit | null;
		derived: boolean;
		nested: boolean;
	};
	data: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class LoadAdsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LoadAdsError";
	}
}

function fail(msg: string): Either.Either<never, Error> {
	return Either.left(new LoadAdsError(msg));
}

// ---------------------------------------------------------------------------
// Store Resolution
// ---------------------------------------------------------------------------

// Resolve a bare scope token (no merchant qualifier) to marketplace infos.
// Supports '*', region keys (na/eu/fe), country codes, and marketplace IDs.
// Returns [] if the token isn't recognized as a scope.
function resolveScope(raw: string): AmazonMarketplaceInfo[] {
	const t = raw.trim();
	if (!t) return [];
	if (t === "*") return Object.values(marketplaceIdToMarketplaceInfo);
	const up = t.toUpperCase();
	if (up in regionCountryCodes) {
		const infos: AmazonMarketplaceInfo[] = [];
		for (const cc of regionCountryCodes[up as keyof typeof regionCountryCodes]) {
			const info = countryCodeToMarketplaceInfo[cc];
			if (info) infos.push(info);
		}
		return infos;
	}
	const byCc = countryCodeToMarketplaceInfo[up];
	// Route through the marketplaceId-keyed map so the GB/UK alias pair always
	// surfaces with the canonical "GB" label, whichever spelling the token used.
	if (byCc) return [marketplaceIdToMarketplaceInfo[byCc.marketplaceId] ?? byCc];
	// Marketplace IDs are case-sensitive; don't uppercase.
	const byId = marketplaceIdToMarketplaceInfo[t];
	if (byId) return [byId];
	return [];
}

// Resolve a --stores spec to concrete (merchant, marketplace) stores.
//
// Each comma-separated token is either a bare scope ('de', 'eu', '*', a
// marketplace ID) — which expands to every merchant selling in that
// marketplace — or a merchant-qualified '{merchantId}-{scope}' token that
// restricts to a single merchant. Merchant <-> marketplace membership is read
// from amazon_store (the static marketplace constants supply currency and the
// storefront label). Merchant IDs contain no '-', so splitting on the first
// '-' is unambiguous.
export function resolveStores(spec: string, sql: postgres.Sql): Effect.Effect<ResolvedStore[], Error> {
	return Effect.gen(function* () {
		// One builder per invocation; it is where a future `.withSchema(workspaceSchema)` would attach.
		const db = createCanonicalQueryBuilder();
		const rows = yield* runCompiled(
			sql,
			() =>
				db
					.selectFrom("amazon_store")
					.select(["merchantId", "marketplaceId", "storeName"])
					// Both columns are non-null `boolean`, so `= true` says exactly what the bare
					// `WHERE "isReal" AND "isActive"` said — and each binds a parameter, which is
					// what keeps this query off postgres.js's SIMPLE protocol.
					.where("isReal", "=", true)
					.where("isActive", "=", true)
					.compile(),
		);

		// marketplaceId -> merchants selling there; plus merchantId -> name lookup
		const merchantsByMarketplace = new Map<string, { merchantId: string; merchantName: string }[]>();
		const knownMerchantIds = new Set<string>();
		const merchantNameById = new Map<string, string>();
		for (const r of rows) {
			knownMerchantIds.add(r.merchantId);
			merchantNameById.set(r.merchantId, r.storeName);
			const arr = merchantsByMarketplace.get(r.marketplaceId) ?? [];
			if (!arr.some((m) => m.merchantId === r.merchantId)) {
				arr.push({ merchantId: r.merchantId, merchantName: r.storeName });
			}
			merchantsByMarketplace.set(r.marketplaceId, arr);
		}

		const seen = new Set<string>(); // `${merchantId}\t${marketplaceId}`
		const result: ResolvedStore[] = [];

		const pushStore = (merchantId: string, merchantName: string, info: AmazonMarketplaceInfo) => {
			const key = `${merchantId}\t${info.marketplaceId}`;
			if (seen.has(key)) return;
			seen.add(key);
			result.push({
				merchantId,
				merchantName,
				marketplaceId: info.marketplaceId,
				countryCode: info.countryCode,
				currency: info.defaultCurrencyCode,
				storeName: `Amazon.${info.domainName.replace("www.amazon.", "")}`,
			});
		};

		const tokens = spec.split(",").map((s) => s.trim()).filter(Boolean);
		for (const token of tokens) {
			const dashIdx = token.indexOf("-");
			if (dashIdx > 0) {
				// {merchantId}-{scope}
				const merchantId = token.slice(0, dashIdx);
				const scope = token.slice(dashIdx + 1);
				if (!knownMerchantIds.has(merchantId)) {
					return yield* fail(
						`Unknown merchant '${merchantId}' in store token '${token}'. Known merchants come from amazon_store.`,
					);
				}
				const infos = resolveScope(scope);
				if (infos.length === 0) {
					return yield* fail(
						`Unknown store scope '${scope}' in token '${token}'. Valid: country codes, regions (na,eu,fe), marketplace IDs, or *.`,
					);
				}
				const merchantName = merchantNameById.get(merchantId)!;
				for (const info of infos) {
					const ms = merchantsByMarketplace.get(info.marketplaceId) ?? [];
					if (ms.some((m) => m.merchantId === merchantId)) {
						pushStore(merchantId, merchantName, info);
					}
				}
			} else {
				// Bare scope -> every merchant selling in the resolved marketplace(s)
				const infos = resolveScope(token);
				if (infos.length === 0) {
					return yield* fail(
						`Unknown store '${token}'. Valid: country codes, regions (na,eu,fe), marketplace IDs, '*', or '{merchantId}-{scope}'.`,
					);
				}
				for (const info of infos) {
					const ms = merchantsByMarketplace.get(info.marketplaceId) ?? [];
					for (const m of ms) pushStore(m.merchantId, m.merchantName, info);
				}
			}
		}

		if (result.length === 0) {
			return yield* fail("No stores resolved (no active merchant sells in the requested marketplace[s])");
		}
		return result;
	});
}

// Distinct marketplaces among the resolved stores (multiple merchants can
// share one marketplace), used for currency / marketplace-keyed SQL.
function distinctMarketplaces(stores: ResolvedStore[]): ResolvedStore[] {
	const seen = new Set<string>();
	const out: ResolvedStore[] = [];
	for (const s of stores) {
		if (!seen.has(s.marketplaceId)) {
			seen.add(s.marketplaceId);
			out.push(s);
		}
	}
	return out;
}

// Distinct merchants among the resolved stores.
function distinctMerchants(stores: ResolvedStore[]): ResolvedStore[] {
	const seen = new Set<string>();
	const out: ResolvedStore[] = [];
	for (const s of stores) {
		if (!seen.has(s.merchantId)) {
			seen.add(s.merchantId);
			out.push(s);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// When Resolution
// ---------------------------------------------------------------------------

function addDurationDays(dateStr: string, dur: WhenAst_Duration, sign: 1 | -1): Either.Either<string, Error> {
	return tryOrOperationError(() => {
		const d = new Date(dateStr + "T00:00:00Z");
		if (dur.years) d.setUTCFullYear(d.getUTCFullYear() + sign * dur.years);
		if (dur.months) d.setUTCMonth(d.getUTCMonth() + sign * dur.months);
		if (dur.weeks) d.setUTCDate(d.getUTCDate() + sign * dur.weeks * 7);
		if (dur.days) d.setUTCDate(d.getUTCDate() + sign * dur.days);
		// Offset by 1 day to make both ends inclusive
		d.setUTCDate(d.getUTCDate() - sign * 1);
		return d.toISOString().slice(0, 10);
	});
}

function extractDate(node: { readonly date: string } | { readonly datetime: string }): string {
	return "date" in node ? node.date : node.datetime.slice(0, 10);
}

export function parseWhenRange(whenStr: string): Either.Either<ParsedWhenRange, Error> {
	return Either.gen(function* () {
		const ast = yield* parseWhenAst(whenStr).pipe(
			Either.mapLeft((cause) => Object.assign(new LoadAdsError(`Invalid --when: ${cause.message}`), { cause })),
		);

		switch (ast._tag) {
			case "Interval_DateDate":
				return { kind: "explicit", range: { dateFirst: ast.left.date, dateLast: ast.right.date } };

			case "Interval_DateTimeDatetime":
				return {
					kind: "explicit",
					range: {
						dateFirst: ast.left.datetime.slice(0, 10),
						dateLast: ast.right.datetime.slice(0, 10),
					},
				};

			case "Interval_DateDuration": {
				const from = extractDate(ast.left);
				const to = yield* addDurationDays(from, ast.right, 1);
				return { kind: "explicit", range: { dateFirst: from, dateLast: to } };
			}

			case "Interval_DurationDate": {
				const to = extractDate(ast.right);
				const from = yield* addDurationDays(to, ast.left, -1);
				return { kind: "explicit", range: { dateFirst: from, dateLast: to } };
			}

			case "Duration":
				return { kind: "trailing", duration: ast };

			default:
				return yield* fail(`Unsupported --when format: ${ast._tag}`);
		}
	});
}

/** Resolve a bare duration against a source-specific inclusive end date. */
export function resolveTrailingRange(duration: WhenAst_Duration, dateLast: string): Either.Either<DateRange, Error> {
	return Either.gen(function* () {
		return { dateFirst: yield* addDurationDays(dateLast, duration, -1), dateLast };
	});
}

export function resolveWhen(
	whenStr: string,
	sql: postgres.Sql,
): Effect.Effect<DateRange, Error> {
	return Effect.gen(function* () {
		const request = yield* parseWhenRange(whenStr);
		if (request.kind === "explicit") {
			return request.range;
		}

		// Duration alone: end = latest advertising data date. Source-specific
		// consumers such as loadTraffic parse the same request and provide their own
		// definitive end date instead of calling this advertising fallback.
		const db = createCanonicalQueryBuilder();
		const latestRow = yield* runCompiled(
			sql,
			() =>
				db
					.selectFrom("amzadapi_reports_v1__search_asin_placement__byDay")
					.select((eb) => eb.cast<string | null>(eb.fn.max("date"), "text").as("latest"))
					// A database-wide MAX has no natural value to bind, and an empty parameter
					// list is what selects postgres.js's SIMPLE protocol. `boundTrue()` supplies one.
					.where(boundTrue())
					.compile(),
		);
		const latest = latestRow[0]?.latest;
		if (!latest) return yield* fail("No ad data found in database");
		return (yield* resolveTrailingRange(request.duration, latest));
	});
}

// ---------------------------------------------------------------------------
// Products Resolution
// ---------------------------------------------------------------------------

export function resolveProducts(
	productsStr: string,
	sql: postgres.Sql,
): Effect.Effect<string[], Error> {
	return Effect.gen(function* () {
		const db = createCanonicalQueryBuilder();
		const tokens = productsStr.split(",").map((s) => s.trim()).filter(Boolean);
		const childAsins = new Set<string>();
		// Only a family-name token reads the family table, so only then is it probed.
		const familyTable = tokens.some((token) => !ASIN_PATTERN.test(token))
			? (yield* probeFamilyTable(db, sql))
			: false;

		for (const token of tokens) {
			if (ASIN_PATTERN.test(token)) {
				// Check if parent ASIN -> expand to children
				const children = yield* runCompiled(
					sql,
					() =>
						db
							.selectFrom("amzspapi_catalog_items_v20220401__catalogitem")
							.select("asin")
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
				if (rows.length === 0) {
					console.error(`Warning: no ASINs found for family '${token}'`);
				}
				for (const row of rows) childAsins.add(row.asin);
			}
		}

		return [...childAsins];
	});
}

/**
 * Whether this workspace has `brand_config_amazon_asin`.
 *
 * No application code creates the table; only the `initRemoteTables` CLI does,
 * so a workspace that has never had brand configuration has none. That is a
 * normal state, not a failure: a family name then matches no ASIN, and the
 * family dimension reports every ASIN under a null family, exactly as it does
 * for an ASIN the table does not map. The probe asks `to_regclass` against the
 * connection's `search_path`, the same question the queries themselves ask.
 */
function probeFamilyTable(db: CanonicalDb, sql: postgres.Sql): Effect.Effect<boolean, Error> {
	return Effect.map(
		probeRelations(db, sql, ["brand_config_amazon_asin"]),
		(present) => present.has("brand_config_amazon_asin"),
	);
}

// ---------------------------------------------------------------------------
// Filter Parsing
// ---------------------------------------------------------------------------

function parseFilter(filterStr: string): Either.Either<FilterExpr, Error> {
	return Either.gen(function* () {
		const parts = filterStr.split(":");
		if (parts.length < 3) return yield* fail(`Invalid --filter format: '${filterStr}'. Expected 'field:op:value'`);
		const field = parts[0];
		const op = parts[1];
		const value = parts.slice(2).join(":");
		if (op !== "=") return yield* fail(`Unsupported filter operator '${op}'. Only '=' is supported`);
		if (field !== "campaignName") {
			return yield* fail(`Unsupported filter field '${field}'. Only 'campaignName' is supported`);
		}
		return { field, op, value };
	});
}

// ---------------------------------------------------------------------------
// SQL Building Helpers
// ---------------------------------------------------------------------------

/**
 * One GROUP BY item plus the string key it de-duplicates on.
 *
 * `[...new Set(...)]` de-duplicates nothing once the entries are expression
 * OBJECTS — each call builds a new one — so the key carries the identity the
 * SQL text used to carry. `country`, `store`, `marketplaceId` and the
 * multi-marketplace currency grouping all emit `r."marketplaceId"`.
 */
interface GroupByEntry {
	readonly key: string;
	readonly expr: Expression<unknown>;
}

function dedupeGroupBy(entries: readonly GroupByEntry[]): Expression<unknown>[] {
	const seen = new Set<string>();
	const out: Expression<unknown>[] = [];
	for (const entry of entries) {
		if (seen.has(entry.key)) continue;
		seen.add(entry.key);
		out.push(entry.expr);
	}
	return out;
}

/**
 * `date_trunc(<unit>, r.date)`, built from `ksql.lit` and `ksql.ref` only.
 *
 * This sub-expression appears in the SELECT list (inside `to_char`) AND in the
 * GROUP BY, and Postgres matches those by parse-tree equality — two `Param`
 * nodes with different placeholder numbers are not equal. One function called
 * from both places is what guarantees byte-identical text.
 */
function dateTrunc(unit: string): RawBuilder<unknown> {
	return ksql`date_trunc(${ksql.lit(unit)}, ${ksql.ref("r.date")})`;
}

function timeUnitSelectExprs(tu: TimeUnit): AliasedExpression<string, string>[] {
	switch (tu) {
		case "DAY":
			return [
				ksql<string>`${ksql.ref("r.date")}::text`.as("dateFirst"),
				ksql<string>`${ksql.ref("r.date")}::text`.as("dateLast"),
			];
		case "WEEK":
			return [
				ksql<string>`to_char(${dateTrunc("week")}, 'YYYY-MM-DD')`.as("dateFirst"),
				ksql<string>`to_char(${dateTrunc("week")} + INTERVAL '6 days', 'YYYY-MM-DD')`.as("dateLast"),
			];
		case "MONTH":
			return [
				ksql<string>`to_char(${dateTrunc("month")}, 'YYYY-MM-DD')`.as("dateFirst"),
				ksql<string>`to_char(${dateTrunc("month")} + INTERVAL '1 month' - INTERVAL '1 day', 'YYYY-MM-DD')`.as(
					"dateLast",
				),
			];
		case "QUARTER":
			return [
				ksql<string>`to_char(${dateTrunc("quarter")}, 'YYYY-MM-DD')`.as("dateFirst"),
				ksql<string>`to_char(${dateTrunc("quarter")} + INTERVAL '3 months' - INTERVAL '1 day', 'YYYY-MM-DD')`
					.as("dateLast"),
			];
		case "YEAR":
			return [
				ksql<string>`to_char(${dateTrunc("year")}, 'YYYY-MM-DD')`.as("dateFirst"),
				ksql<string>`to_char(${dateTrunc("year")} + INTERVAL '1 year' - INTERVAL '1 day', 'YYYY-MM-DD')`.as(
					"dateLast",
				),
			];
	}
}

function timeUnitGroupBy(tu: TimeUnit): GroupByEntry {
	switch (tu) {
		case "DAY":
			return { key: `r.date`, expr: ksql.ref("r.date") };
		case "WEEK":
			return { key: `date_trunc('week', r.date)`, expr: dateTrunc("week") };
		case "MONTH":
			return { key: `date_trunc('month', r.date)`, expr: dateTrunc("month") };
		case "QUARTER":
			return { key: `date_trunc('quarter', r.date)`, expr: dateTrunc("quarter") };
		case "YEAR":
			return { key: `date_trunc('year', r.date)`, expr: dateTrunc("year") };
	}
}

const TIME_UNIT_OUTPUT_COLS = ["dateFirst", "dateLast"];

// Dimensions that resolve to a specific product (directly or via family/parentAsin
// lookup keyed on the resolved ASIN). Their presence in groupBy means the query is
// at ASIN/product grain rather than store/total grain.
const PRODUCT_GRAIN_DIMS: readonly GroupByDim[] = ["asin", "family", "parentAsin"];

function isProductGrain(dims: readonly GroupByDim[]): boolean {
	return dims.some((d) => PRODUCT_GRAIN_DIMS.includes(d));
}

// Sponsored Brands rows appear twice in both search_asin_placement__byDay and
// product01__byDay: an aggregate row (advertisedProductId = '') carrying the true
// campaign total, and per-ASIN breakdown rows that re-report a split of that spend.
// Summing both double-counts SB.
//
//   - store/total grain: keep the aggregate row only and drop the per-ASIN rows
//     (SP/SD have no aggregate row and are unaffected).
//   - ASIN/product grain: keep the per-ASIN breakdown rows instead (the aggregate
//     row only resolves to the ad's *first* creative ASIN via sb_asin_lookup, which
//     would misattribute — or omit — spend for every other ASIN in the campaign) and
//     drop the aggregate row so it isn't summed on top of the per-ASIN split.
//
// Only the OPERATOR differs between the two, so it lives here on its own while
// each query builds the predicate with its own expression builder — that keeps
// `r."adProduct"` and `r."advertisedProductId"` checked against `DB`.
function sbDoubleCountOp(productGrain: boolean): "=" | "<>" {
	return productGrain ? "=" : "<>";
}

/**
 * The resolved advertised ASIN for the search_asin_placement query, handling SB
 * ASIN resolution via the sb_asin_lookup CTE.
 *
 * It appears in the SELECT list, the GROUP BY, two JOIN predicates and the
 * `--products` WHERE clause. Postgres matches a GROUP BY expression against a
 * SELECT expression by parse-tree equality, so every call site must emit
 * byte-identical text — which rules out `eb.val`, whose placeholder number
 * differs per position. `ksql.ref` and `ksql.lit` only. `UNRESOLVED_ASIN` is a
 * source constant and stays a literal, exactly as it was.
 */
function resolvedAsinExpr(): RawBuilder<string> {
	return ksql<string>`COALESCE(NULLIF(${ksql.ref("r.advertisedProductId")}, ${ksql.lit("")}), ${
		ksql.ref("sb_lookup.first_asin")
	}, ${ksql.lit(UNRESOLVED_ASIN)})`;
}

// Same for product01 (halo-in uses convertedProductId as the asin)
function resolvedAsinExprProduct01(): RawBuilder<string> {
	return ksql.ref<string>("r.convertedProductId");
}

// ---------------------------------------------------------------------------
// groupBy -> SQL mapping for the search_asin_placement query
// ---------------------------------------------------------------------------

interface DimJoinFlags {
	readonly needsCampaignJoin: boolean;
	readonly needsAdJoin: boolean;
	readonly needsFamilyJoin: boolean;
	readonly needsParentAsinJoin: boolean;
}

interface DimPlan extends DimJoinFlags {
	readonly outputCols: string[];
}

/**
 * The half of the dimension mapping that needs neither stores nor expressions:
 * the output column names and which optional joins the dimensions require.
 *
 * `mergeResults` wants only the names, and both query builders need the join
 * flags BEFORE they can build a select list — so this is pure and is the one
 * place either answer is written.
 */
function dimPlan(dims: GroupByDim[]): DimPlan {
	const outputCols: string[] = [];
	let needsCampaignJoin = false;
	let needsAdJoin = false;
	let needsFamilyJoin = false;
	let needsParentAsinJoin = false;

	for (const dim of dims) {
		switch (dim) {
			case "asin":
				outputCols.push("asin");
				break;
			case "family":
				needsFamilyJoin = true;
				outputCols.push("family");
				break;
			case "parentAsin":
				needsParentAsinJoin = true;
				outputCols.push("parentAsin");
				break;
			case "campaign":
				needsCampaignJoin = true;
				outputCols.push("campaignId", "campaignName");
				break;
			case "adType":
				needsCampaignJoin = true;
				needsAdJoin = true;
				outputCols.push("adType");
				break;
			case "placement":
				outputCols.push("placement");
				break;
			case "target":
				outputCols.push("target");
				break;
			case "adgroup":
				outputCols.push("adGroupId");
				break;
			case "country":
				outputCols.push("country");
				break;
			case "store":
				outputCols.push("store");
				break;
			case "merchant":
				outputCols.push("merchantId", "merchantName");
				break;
			case "marketplaceId":
				outputCols.push("marketplaceId");
				break;
		}
	}

	return { outputCols, needsCampaignJoin, needsAdJoin, needsFamilyJoin, needsParentAsinJoin };
}

/**
 * A TABLE-LESS expression builder, shared by both queries' dimension expressions.
 *
 * The two queries read different tables: `placementClassification` and `target`
 * exist on `amzadapi_reports_v1__search_asin_placement__byDay` and NOT on
 * `amzadapi_reports_v1__product01__byDay`, in the generated `DB` and in the
 * fixture schema alike. So one TYPED builder cannot serve both — `eb.ref("r.target")`
 * would not compile against the halo-in query. Today `--groupBy target` makes
 * query 2 fail at runtime, and that is existing behaviour which is preserved
 * here deliberately rather than fixed; `buildQuery2` leaves `placement` out of
 * its dimensions instead.
 *
 * The consequence, and it is worth stating rather than reading as an oversight:
 * every `r.` / `camp.` / `ad.` / `fam.` / `cat.` reference in the dimension
 * expressions below is written with `ksql.ref` and is NOT checked against `DB`.
 * Everything else in both queries — the metric aggregates, the WHERE predicates
 * on `r.*`, the CTE and every join predicate — stays typed.
 */
const xb = expressionBuilder<Record<string, never>, never>();

type DimExpression<T> = ExpressionWrapper<Record<string, never>, never, T>;

/**
 * A bound text value for a CASE branch.
 *
 * `cast($n as text)` rather than a naked `$n`: a CASE whose every branch is an
 * untyped parameter leaves Postgres nothing to resolve the result type from.
 * The string-built version already wrote `::text` on the merchant branch for
 * exactly this reason.
 */
function textVal(value: string): DimExpression<string> {
	return xb.cast<string>(xb.val(value), "text");
}

/**
 * `CASE WHEN <ref> = <match> THEN <label> … END`, one branch per row.
 *
 * The values were interpolated as quoted SQL literals before: `marketplaceId`,
 * `countryCode`, `storeName` and `currency` come from the static
 * `amazonConstants` marketplace table, while `merchantId` / `merchantName` are
 * read out of `amazon_store` and were already bound. `eb.case()` binds them all,
 * which is a strict improvement — and none of these expressions reaches a GROUP
 * BY, so the bound parameters cannot trip the parse-tree-equality rule.
 */
function caseOverRef(
	ref: string,
	rows: readonly ResolvedStore[],
	match: (store: ResolvedStore) => string,
	label: (store: ResolvedStore) => string,
): Either.Either<DimExpression<string | null>, Error> {
	return Either.gen(function* () {
		const first = rows[0];
		// `resolveStores` fails rather than returning an empty list, so this is
		// unreachable; the string-built version emitted `CASE  END`, a syntax error.
		if (!first) return yield* fail("No stores resolved");
		let expr = xb.case().when(ksql.ref<string>(ref), "=", match(first)).then(textVal(label(first)));
		for (const row of rows.slice(1)) {
			expr = expr.when(ksql.ref<string>(ref), "=", match(row)).then(textVal(label(row)));
		}
		return expr.end();
	});
}

function marketplaceIdGroupBy(): GroupByEntry {
	return { key: `r."marketplaceId"`, expr: ksql.ref("r.marketplaceId") };
}

interface DimExprs {
	readonly selectExprs: AliasedExpression<unknown, string>[];
	readonly groupBy: GroupByEntry[];
}

function buildDimExprs(
	dims: GroupByDim[],
	stores: ResolvedStore[],
	resolvedAsin: RawBuilder<string>,
	familyTable: boolean,
): Either.Either<DimExprs, Error> {
	return Either.gen(function* () {
		const selectExprs: AliasedExpression<unknown, string>[] = [];
		const groupBy: GroupByEntry[] = [];

		for (const dim of dims) {
			switch (dim) {
				case "asin":
					selectExprs.push(resolvedAsin.as("asin"));
					groupBy.push({ key: "resolvedAsin", expr: resolvedAsin });
					break;
				case "family": {
					// Without the family table there is no `fam` to read, so every ASIN is
					// unmapped: `NULL::text`, which is an expression Postgres accepts in a
					// GROUP BY where a bare `NULL` is a rejected constant.
					const family = familyTable
						? ksql.ref<string | null>("fam.family")
						: ksql<string | null>`NULL::text`;
					selectExprs.push(family.as("family"));
					groupBy.push({ key: `fam.family`, expr: family });
					break;
				}
				case "parentAsin":
					selectExprs.push(ksql.ref<string | null>("cat.parent_asin").as("parentAsin"));
					groupBy.push({ key: `cat.parent_asin`, expr: ksql.ref("cat.parent_asin") });
					break;
				case "campaign":
					selectExprs.push(ksql.ref<string>("r.campaignId").as("campaignId"));
					selectExprs.push(ksql.ref<string | null>("camp.name").as("campaignName"));
					groupBy.push({ key: `r."campaignId"`, expr: ksql.ref("r.campaignId") });
					groupBy.push({ key: `camp.name`, expr: ksql.ref("camp.name") });
					break;
				case "adType": {
					// The same nested CASE object is used in two THEN branches; expression
					// objects are immutable AST wrappers, so sharing one is safe and each
					// position compiles its own placeholder numbering.
					const sbOrSbv = xb.case()
						.when(xb(ksql.ref<string>("ad.adType"), "in", ["VIDEO", "BRAND_VIDEO"]))
						.then(textVal("SBV"))
						.else(textVal("SB"))
						.end();
					selectExprs.push(
						xb.case()
							.when(ksql.ref<string>("camp.adProduct"), "=", "SPONSORED_PRODUCTS").then(textVal("SP"))
							.when(ksql.ref<string>("camp.adProduct"), "=", "SPONSORED_DISPLAY").then(textVal("SD"))
							.when(ksql.ref<string>("camp.adProduct"), "in", [
								"SPONSORED_BRANDS",
								"SPONSORED_BRANDS_VIDEO",
							]).then(sbOrSbv)
							.when(ksql.ref<string>("r.adProduct"), "=", "Sponsored Products").then(textVal("SP"))
							.when(ksql.ref<string>("r.adProduct"), "=", "Sponsored Display").then(textVal("SD"))
							.when(ksql.ref<string>("r.adProduct"), "=", "Sponsored Brands").then(sbOrSbv)
							.else(xb.fn.coalesce(ksql.ref<string>("camp.adProduct"), ksql.ref<string>("r.adProduct")))
							.end()
							.as("adType"),
					);
					groupBy.push({ key: `camp."adProduct"`, expr: ksql.ref("camp.adProduct") });
					groupBy.push({ key: `ad."adType"`, expr: ksql.ref("ad.adType") });
					groupBy.push({ key: `r."adProduct"`, expr: ksql.ref("r.adProduct") });
					break;
				}
				case "placement":
					selectExprs.push(ksql.ref<string>("r.placementClassification").as("placement"));
					groupBy.push({
						key: `r."placementClassification"`,
						expr: ksql.ref("r.placementClassification"),
					});
					break;
				case "target":
					selectExprs.push(ksql.ref<string>("r.target").as("target"));
					groupBy.push({ key: `r.target`, expr: ksql.ref("r.target") });
					break;
				case "adgroup":
					selectExprs.push(ksql.ref<string>("r.adGroupId").as("adGroupId"));
					groupBy.push({ key: `r."adGroupId"`, expr: ksql.ref("r.adGroupId") });
					break;
				case "country":
					// marketplaceId -> country code, from the static marketplace constants.
					selectExprs.push(
						(yield* caseOverRef(
							"r.marketplaceId",
							distinctMarketplaces(stores),
							(s) => s.marketplaceId,
							(s) => s.countryCode,
						)).as("country"),
					);
					groupBy.push(marketplaceIdGroupBy());
					break;
				case "store":
					// Storefront label per marketplace (e.g. Amazon.de). `storeName` here is
					// built by `resolveStores` from the static marketplace `domainName`, NOT
					// from `amazon_store."storeName"`.
					selectExprs.push(
						(yield* caseOverRef(
							"r.marketplaceId",
							distinctMarketplaces(stores),
							(s) => s.marketplaceId,
							(s) => s.storeName,
						)).as("store"),
					);
					groupBy.push(marketplaceIdGroupBy());
					break;
				case "merchant":
					// Seller account: merchantId + its amazon_store name. Both are read out of
					// `amazon_store`, and both were already bound before this conversion.
					selectExprs.push(ksql.ref<string>("r.merchantId").as("merchantId"));
					selectExprs.push(
						(yield* caseOverRef(
							"r.merchantId",
							distinctMerchants(stores),
							(s) => s.merchantId,
							(s) => s.merchantName,
						)).as("merchantName"),
					);
					groupBy.push({ key: `r."merchantId"`, expr: ksql.ref("r.merchantId") });
					break;
				case "marketplaceId":
					selectExprs.push(ksql.ref<string>("r.marketplaceId").as("marketplaceId"));
					groupBy.push(marketplaceIdGroupBy());
					break;
			}
		}

		return { selectExprs, groupBy };
	});
}

// ---------------------------------------------------------------------------
// Currency mapping: always add currency to output
// ---------------------------------------------------------------------------

// `currency` and `marketplaceId` both come from the static `amazonConstants` marketplace
// table, never from the DB or from caller text. They were interpolated as quoted SQL
// literals and are now bound, which is strictly safer; neither form reaches a GROUP BY.
function currencyCaseExpr(stores: ResolvedStore[]): Either.Either<AliasedExpression<string | null, string>, Error> {
	return Either.gen(function* () {
		const currencies = new Set(stores.map((s) => s.currency));
		if (currencies.size <= 1) {
			const only = stores[0]?.currency ?? "";
			return textVal(only).as("currency");
		}
		return (yield* caseOverRef(
			"r.marketplaceId",
			distinctMarketplaces(stores),
			(s) => s.marketplaceId,
			(s) => s.currency,
		)).as("currency");
	});
}

// ---------------------------------------------------------------------------
// Query 1: Advertised + Halo-out (search_asin_placement__byDay)
// ---------------------------------------------------------------------------

/** Which optional LEFT JOINs a statement needs: the dimensions' four, plus the `--filter` one. */
interface QueryJoins extends DimJoinFlags {
	/** Added only when the dimensions did not already join `camp`; see `buildQuery1`. */
	readonly needsCampFiltJoin: boolean;
}

function queryJoins(plan: DimPlan, filter: FilterExpr | null, familyTable: boolean): QueryJoins {
	return {
		needsCampaignJoin: plan.needsCampaignJoin,
		needsAdJoin: plan.needsAdJoin,
		// A workspace without the family table has nothing to join; see `probeFamilyTable`.
		needsFamilyJoin: plan.needsFamilyJoin && familyTable,
		needsParentAsinJoin: plan.needsParentAsinJoin,
		needsCampFiltJoin: filter !== null && !plan.needsCampaignJoin,
	};
}

/**
 * The `sb_asin_lookup` CTE: a Sponsored Brands ad's first creative ASIN.
 *
 * The store predicate binds BOTH halves of each pair. The string-built version
 * bound `merchantId` and interpolated `marketplaceId` as a quoted literal.
 */
function sbAsinLookup(db: CanonicalDb, stores: ResolvedStore[]) {
	return db.with("sb_asin_lookup", (qb) =>
		qb
			.selectFrom("amzadapi_exports_v1__ad")
			.select((eb) => [
				"adId",
				"marketplaceId",
				eb.fn.coalesce(
					jsonbText(eb.ref("creative"), "products", 0, "productId"),
					jsonbText(eb.ref("creative"), "asins", 0),
				).as("first_asin"),
			])
			.where((eb) =>
				eb(
					eb.refTuple("merchantId", "marketplaceId"),
					"in",
					stores.map((s) => eb.tuple(s.merchantId, s.marketplaceId)),
				)
			)
			.where("adProduct", "in", ["SPONSORED_BRANDS", "SPONSORED_BRANDS_VIDEO"]));
}

/**
 * Query 1's FROM and its joins.
 *
 * `$if` is how a conditional join is written: `.where()` does not change the
 * builder's type so a plain `if` and a reassignment serve there, but a join
 * does, and only `$if` keeps the chain assignable. Note that `$if` does NOT add
 * the joined alias to the outer type — after these calls the table list is still
 * `r | sb_lookup` — which is why every later reference to `camp`, `ad`, `fam`,
 * `cat` and `camp_filt` goes through `ksql.ref`. The join predicates INSIDE each
 * callback are fully checked against `DB`.
 */
function query1Base(db: CanonicalDb, stores: ResolvedStore[], joins: QueryJoins) {
	return sbAsinLookup(db, stores)
		.selectFrom("amzadapi_reports_v1__search_asin_placement__byDay as r")
		.leftJoin("sb_asin_lookup as sb_lookup", (join) =>
			join
				.onRef("r.adId", "=", "sb_lookup.adId")
				.onRef("r.marketplaceId", "=", "sb_lookup.marketplaceId"))
		.$if(joins.needsCampaignJoin, (qb) =>
			qb.leftJoin("amzadapi_exports_v1__campaign as camp", (join) =>
				join
					.onRef("r.campaignId", "=", "camp.campaignId")
					.onRef("r.merchantId", "=", "camp.merchantId")
					.onRef("r.marketplaceId", "=", "camp.marketplaceId")))
		.$if(joins.needsAdJoin, (qb) =>
			qb.leftJoin("amzadapi_exports_v1__ad as ad", (join) =>
				join
					.onRef("r.adId", "=", "ad.adId")
					.onRef("r.merchantId", "=", "ad.merchantId")
					.onRef("r.marketplaceId", "=", "ad.marketplaceId")))
		.$if(
			joins.needsFamilyJoin,
			(qb) =>
				qb.leftJoin("brand_config_amazon_asin as fam", (join) => join.on("fam.asin", "=", resolvedAsinExpr())),
		)
		.$if(joins.needsParentAsinJoin, (qb) =>
			qb.leftJoin(
				"amzspapi_catalog_items_v20220401__catalogitem as cat",
				(join) => join.on("cat.asin", "=", resolvedAsinExpr()),
			))
		.$if(joins.needsCampFiltJoin, (qb) =>
			qb.leftJoin("amzadapi_exports_v1__campaign as camp_filt", (join) =>
				join
					.onRef("r.campaignId", "=", "camp_filt.campaignId")
					.onRef("r.merchantId", "=", "camp_filt.merchantId")
					.onRef("r.marketplaceId", "=", "camp_filt.marketplaceId")));
}

function buildQuery1(
	db: CanonicalDb,
	stores: ResolvedStore[],
	range: DateRange,
	dims: GroupByDim[],
	timeUnit: TimeUnit | null,
	productAsins: string[] | null,
	filter: FilterExpr | null,
	familyTable: boolean,
) {
	return Either.gen(function* () {
		const plan = dimPlan(dims);
		const productGrain = isProductGrain(dims);
		// One expression object, reused in the SELECT list, the GROUP BY, the two
		// optional joins and the `--products` predicate: identical text everywhere.
		const resolvedAsin = resolvedAsinExpr();
		const dims1 = yield* buildDimExprs(dims, stores, resolvedAsin, familyTable);
		const currency = yield* currencyCaseExpr(stores);

		const groupByCols: GroupByEntry[] = [];
		// Currency grouping (for multi-store)
		if (distinctMarketplaces(stores).length > 1) groupByCols.push(marketplaceIdGroupBy());
		if (timeUnit) groupByCols.push(timeUnitGroupBy(timeUnit));
		groupByCols.push(...dims1.groupBy);

		let query = query1Base(db, stores, queryJoins(plan, filter, familyTable))
			.select((eb) => [
				currency,
				...(timeUnit ? timeUnitSelectExprs(timeUnit) : []),
				...dims1.selectExprs,
				// Advertised metrics
				eb.fn.sum<string | null>("r.impressions").as("impressions"),
				eb.fn.sum<string | null>("r.clicks").as("clicks"),
				eb.fn.sum<string | null>("r.addToCart").as("addToCart"),
				eb.fn.sum<string | null>("r.purchases").as("purchases"),
				eb.fn.sum<string | null>("r.unitsSold").as("units"),
				// The cast is on the COLUMN, INSIDE the aggregate, as `SUM(r."totalCost"::float)`
				// was: `cast(sum(...) as float8)` would add `numeric` exactly and round once,
				// which is a different number in the last bits.
				eb.fn.sum<number | null>(eb.cast<number>(eb.ref("r.totalCost"), "float8")).as("spend"),
				eb.fn.sum<number | null>(eb.cast<number>(eb.ref("r.sales"), "float8")).as("revenue"),
				// Halo-out metrics
				eb.fn.sum<string | null>("r.purchasesHalo").as("purchasesHaloOut"),
				eb.fn.sum<string | null>("r.unitsSoldHalo").as("unitsHaloOut"),
				eb.fn.sum<number | null>(eb.cast<number>(eb.ref("r.salesHalo"), "float8")).as("revenueHaloOut"),
			])
			.where((eb) =>
				eb(
					eb.refTuple("r.merchantId", "r.marketplaceId"),
					"in",
					stores.map((s) => eb.tuple(s.merchantId, s.marketplaceId)),
				)
			)
			// `range` derives from the caller's `when` (or from MAX(date)); bind both ends.
			.where("r.date", ">=", isoDateParam(range.dateFirst))
			.where("r.date", "<=", isoDateParam(range.dateLast))
			.where((eb) =>
				eb.not(eb.and([
					eb("r.adProduct", "=", "Sponsored Brands"),
					eb("r.advertisedProductId", sbDoubleCountOp(productGrain), ""),
				]))
			);
		if (productAsins) {
			// ASINs come out of client tables (`brand_config_amazon_asin`, the catalog),
			// i.e. attacker-writable data — bind every one of them.
			query = query.where(resolvedAsin, "in", productAsins);
		}
		if (filter) {
			// The filter value is raw caller text (`--filter campaignName:=:<value>`).
			query = query.where(
				ksql.ref<string>(plan.needsCampaignJoin ? "camp.name" : "camp_filt.name"),
				"=",
				filter.value,
			);
		}

		return (yield* tryOrOperationError(() => query.groupBy(dedupeGroupBy(groupByCols)).compile()));
	});
}

// ---------------------------------------------------------------------------
// Query 2: Halo-in (product01__byDay)
// ---------------------------------------------------------------------------

/** Query 2's FROM and its joins. See {@link query1Base} for the `$if` reasoning. */
function query2Base(db: CanonicalDb, stores: ResolvedStore[], joins: QueryJoins) {
	return sbAsinLookup(db, stores)
		.selectFrom("amzadapi_reports_v1__product01__byDay as r")
		.leftJoin("sb_asin_lookup as sb_lookup", (join) =>
			join
				.onRef("r.adId", "=", "sb_lookup.adId")
				.onRef("r.marketplaceId", "=", "sb_lookup.marketplaceId"))
		.$if(joins.needsCampaignJoin, (qb) =>
			qb.leftJoin("amzadapi_exports_v1__campaign as camp", (join) =>
				join
					.onRef("r.campaignId", "=", "camp.campaignId")
					.onRef("r.merchantId", "=", "camp.merchantId")
					.onRef("r.marketplaceId", "=", "camp.marketplaceId")))
		.$if(joins.needsAdJoin, (qb) =>
			qb.leftJoin("amzadapi_exports_v1__ad as ad", (join) =>
				join
					.onRef("r.adId", "=", "ad.adId")
					.onRef("r.merchantId", "=", "ad.merchantId")
					.onRef("r.marketplaceId", "=", "ad.marketplaceId")))
		// For halo-in, family is on the converted product (the one that received halo)
		.$if(joins.needsFamilyJoin, (qb) =>
			qb.leftJoin(
				"brand_config_amazon_asin as fam",
				(join) => join.on("fam.asin", "=", resolvedAsinExprProduct01()),
			))
		.$if(joins.needsParentAsinJoin, (qb) =>
			qb.leftJoin(
				"amzspapi_catalog_items_v20220401__catalogitem as cat",
				(join) => join.on("cat.asin", "=", resolvedAsinExprProduct01()),
			))
		.$if(joins.needsCampFiltJoin, (qb) =>
			qb.leftJoin("amzadapi_exports_v1__campaign as camp_filt", (join) =>
				join
					.onRef("r.campaignId", "=", "camp_filt.campaignId")
					.onRef("r.merchantId", "=", "camp_filt.merchantId")
					.onRef("r.marketplaceId", "=", "camp_filt.marketplaceId")));
}

function buildQuery2(
	db: CanonicalDb,
	stores: ResolvedStore[],
	range: DateRange,
	dims: GroupByDim[],
	timeUnit: TimeUnit | null,
	productAsins: string[] | null,
	filter: FilterExpr | null,
	familyTable: boolean,
) {
	return Either.gen(function* () {
		// For halo-in, the ASIN is convertedProductId (which product received the halo).
		// We still need sb_asin_lookup for dimensions that depend on the advertised product.
		const plan = dimPlan(dims);
		const productGrain = isProductGrain(dims);
		const resolvedAsin = resolvedAsinExprProduct01();
		// product01 has no placement column, so halo-in cannot be split by placement:
		// this query groups without it and reports its rows under a NULL placement,
		// which `mergeResults` keeps as their own output row.
		const dims2 = yield* buildDimExprs(
			dims.filter((dim) => dim !== "placement"),
			stores,
			resolvedAsin,
			familyTable,
		);
		const currency = yield* currencyCaseExpr(stores);

		const groupByCols: GroupByEntry[] = [];
		if (distinctMarketplaces(stores).length > 1) groupByCols.push(marketplaceIdGroupBy());
		if (timeUnit) groupByCols.push(timeUnitGroupBy(timeUnit));
		groupByCols.push(...dims2.groupBy);

		let query = query2Base(db, stores, queryJoins(plan, filter, familyTable))
			.select((eb) => [
				currency,
				...(timeUnit ? timeUnitSelectExprs(timeUnit) : []),
				...dims2.selectExprs,
				...(dims.includes("placement") ? [ksql<null>`NULL`.as("placement")] : []),
				// Halo-in metrics
				eb.fn.sum<string | null>("r.purchases").as("purchasesHaloIn"),
				eb.fn.sum<string | null>("r.unitsSold").as("unitsHaloIn"),
				// The cast stays INSIDE the aggregate; see buildQuery1.
				eb.fn.sum<number | null>(eb.cast<number>(eb.ref("r.sales"), "float8")).as("revenueHaloIn"),
			])
			.where((eb) =>
				eb(
					eb.refTuple("r.merchantId", "r.marketplaceId"),
					"in",
					stores.map((s) => eb.tuple(s.merchantId, s.marketplaceId)),
				)
			)
			// `range` derives from the caller's `when` (or from MAX(date)); bind both ends.
			.where("r.date", ">=", isoDateParam(range.dateFirst))
			.where("r.date", "<=", isoDateParam(range.dateLast))
			.where("r.productRelevance", "=", "Brand halo")
			// Same SB aggregate/per-ASIN double-count as buildQuery1, level-aware the same
			// way: at ASIN/product grain keep the per-ASIN breakdown rows (convertedProductId
			// is populated on both the aggregate and per-ASIN rows, so grain is driven by the
			// requested dims, not by which column this query keys on).
			.where((eb) =>
				eb.not(eb.and([
					eb("r.adProduct", "=", "Sponsored Brands"),
					eb("r.advertisedProductId", sbDoubleCountOp(productGrain), ""),
				]))
			);
		if (productAsins) {
			// ASINs come out of client tables (`brand_config_amazon_asin`, the catalog),
			// i.e. attacker-writable data — bind every one of them.
			query = query.where(resolvedAsin, "in", productAsins);
		}
		if (filter) {
			// The filter value is raw caller text (`--filter campaignName:=:<value>`).
			query = query.where(
				ksql.ref<string>(plan.needsCampaignJoin ? "camp.name" : "camp_filt.name"),
				"=",
				filter.value,
			);
		}

		return (yield* tryOrOperationError(() => query.groupBy(dedupeGroupBy(groupByCols)).compile()));
	});
}

// ---------------------------------------------------------------------------
// In-memory Merge
// ---------------------------------------------------------------------------

function buildMergeKey(row: Record<string, unknown>, keyCols: string[]): string {
	return keyCols.map((c) => String(row[c] ?? "")).join("\t");
}

function mergeResults(
	q1Rows: Record<string, unknown>[],
	q2Rows: Record<string, unknown>[],
	dims: GroupByDim[],
	timeUnit: TimeUnit | null,
	derivedFlag: boolean,
	nestedFlag: boolean,
): Record<string, unknown>[] {
	// Build key columns: currency + timeUnit cols + dimension output cols
	const keyCols = ["currency"];
	if (timeUnit) keyCols.push(...TIME_UNIT_OUTPUT_COLS);
	// Only the output column NAMES are wanted here; the expressions (and the
	// parameters they would bind) are the query builders' business.
	keyCols.push(...dimPlan(dims).outputCols);

	// Pre-aggregate: SQL groups by raw camp/ad/r columns, but the CASE
	// expressions (e.g. adType) collapse multiple raw groups into one output
	// label. Merge those collisions by summing numeric columns; otherwise
	// later Map-based indexing would silently drop all but the last colliding
	// row.
	const aggregatedQ1 = collapseByKey(q1Rows, keyCols);
	const aggregatedQ2 = collapseByKey(q2Rows, keyCols);

	// Index q2 by merge key
	const q2Index = new Map<string, Record<string, unknown>>();
	for (const row of aggregatedQ2) {
		q2Index.set(buildMergeKey(row, keyCols), row);
	}

	// Collect all keys from both queries
	const allKeys = new Map<string, Record<string, unknown>>();
	for (const row of aggregatedQ1) {
		allKeys.set(buildMergeKey(row, keyCols), row);
	}
	for (const row of aggregatedQ2) {
		const key = buildMergeKey(row, keyCols);
		if (!allKeys.has(key)) {
			allKeys.set(key, row);
		}
	}

	const output: Record<string, unknown>[] = [];

	// Build a Set of q1 keys for O(1) origin lookups (the previous .some()
	// was O(n_q1) per output row).
	const q1KeySet = new Set(aggregatedQ1.map((r) => buildMergeKey(r, keyCols)));

	for (const [key, q1Row] of allKeys) {
		const q2Row = q2Index.get(key);
		const isQ1 = q1KeySet.has(key);

		// Start with key columns from whichever row exists
		const baseRow = isQ1 ? q1Row : q2Row!;
		const outRow: Record<string, unknown> = {};

		for (const col of keyCols) {
			outRow[col] = baseRow[col];
		}

		// Advertised metrics (from q1)
		const impressions = isQ1 ? Number(q1Row["impressions"] ?? 0) : 0;
		const clicks = isQ1 ? Number(q1Row["clicks"] ?? 0) : 0;
		const addToCart = isQ1 ? Number(q1Row["addToCart"] ?? 0) : 0;
		const purchases = isQ1 ? Number(q1Row["purchases"] ?? 0) : 0;
		const units = isQ1 ? Number(q1Row["units"] ?? 0) : 0;
		const spend = isQ1 ? Number(q1Row["spend"] ?? 0) : 0;
		const revenue = isQ1 ? Number(q1Row["revenue"] ?? 0) : 0;

		// Halo-out (from q1)
		const purchasesHaloOut = isQ1 ? Number(q1Row["purchasesHaloOut"] ?? 0) : 0;
		const unitsHaloOut = isQ1 ? Number(q1Row["unitsHaloOut"] ?? 0) : 0;
		const revenueHaloOut = isQ1 ? Number(q1Row["revenueHaloOut"] ?? 0) : 0;

		// Halo-in (from q2)
		const purchasesHaloIn = q2Row ? Number(q2Row["purchasesHaloIn"] ?? 0) : 0;
		const unitsHaloIn = q2Row ? Number(q2Row["unitsHaloIn"] ?? 0) : 0;
		const revenueHaloIn = q2Row ? Number(q2Row["revenueHaloIn"] ?? 0) : 0;

		if (nestedFlag) {
			outRow["adStats"] = {
				impressions,
				clicks,
				addToCart,
				purchases,
				units,
				spend: round2(spend),
				revenue: round2(revenue),
			};
			outRow["adStatsHaloOut"] = {
				impressions: null,
				clicks: null,
				addToCart: null,
				purchases: purchasesHaloOut,
				units: unitsHaloOut,
				spend: null,
				revenue: round2(revenueHaloOut),
			};
			outRow["adStatsHaloIn"] = {
				impressions: null,
				clicks: null,
				addToCart: null,
				purchases: purchasesHaloIn,
				units: unitsHaloIn,
				spend: null,
				revenue: round2(revenueHaloIn),
			};
		} else {
			outRow["impressions"] = impressions;
			outRow["clicks"] = clicks;
			outRow["addToCart"] = addToCart;
			outRow["purchases"] = purchases;
			outRow["units"] = units;
			outRow["spend"] = round2(spend);
			outRow["revenue"] = round2(revenue);
			outRow["purchasesHaloOut"] = purchasesHaloOut;
			outRow["unitsHaloOut"] = unitsHaloOut;
			outRow["revenueHaloOut"] = round2(revenueHaloOut);
			outRow["purchasesHaloIn"] = purchasesHaloIn;
			outRow["unitsHaloIn"] = unitsHaloIn;
			outRow["revenueHaloIn"] = round2(revenueHaloIn);
		}

		// Derived metrics (on advertised stats only)
		if (derivedFlag) {
			const derived: Record<string, number | null> = {
				ctr: impressions > 0 ? round4(clicks / impressions) : null,
				cr: clicks > 0 ? round4(purchases / clicks) : null,
				cpc: clicks > 0 ? round2(spend / clicks) : null,
				acos: revenue > 0 ? round4(spend / revenue) : null,
				roas: spend > 0 ? round2(revenue / spend) : null,
			};
			if (nestedFlag) {
				outRow["derived"] = derived;
			} else {
				Object.assign(outRow, derived);
			}
		}

		output.push(outRow);
	}

	return output;
}

// Collapse rows that share the same merge key by summing every numeric
// (non-key) column. Non-numeric non-key columns are taken from the first
// occurrence — they're either constants per key (currency) or shouldn't be
// in the row at this point. Order is preserved (first-seen).
function collapseByKey(
	rows: Record<string, unknown>[],
	keyCols: string[],
): Record<string, unknown>[] {
	if (rows.length === 0) return rows;
	const keySet = new Set(keyCols);
	const acc = new Map<string, Record<string, unknown>>();
	for (const row of rows) {
		const key = buildMergeKey(row, keyCols);
		const existing = acc.get(key);
		if (!existing) {
			acc.set(key, { ...row });
			continue;
		}
		for (const [col, val] of Object.entries(row)) {
			if (keySet.has(col)) continue;
			const a = Number(existing[col] ?? 0);
			const b = Number(val ?? 0);
			if (!Number.isNaN(a) && !Number.isNaN(b)) {
				existing[col] = a + b;
			}
		}
	}
	return [...acc.values()];
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function loadAds(
	params: LoadAdsParams,
	sql: postgres.Sql,
): Effect.Effect<LoadAdsResult, Error> {
	return Effect.gen(function* () {
		// Validate required fields
		if (!params.stores) return yield* fail("--stores is required");
		if (!params.when) return yield* fail("--when is required");
		if (!params.groupBy) return yield* fail("--groupBy is required");

		// One builder for the whole invocation, built before anything is assembled: it
		// is where a future `.withSchema(workspaceSchema)` would attach.
		const db = createCanonicalQueryBuilder();

		// Resolve stores (merchant <-> marketplace mapping comes from amazon_store)
		const stores = yield* resolveStores(params.stores, sql);

		// Validate groupBy
		const groupByDims = params.groupBy.split(",").map((s) => s.trim()) as GroupByDim[];
		for (const dim of groupByDims) {
			if (!VALID_GROUP_BY.includes(dim)) {
				return yield* fail(`Unknown --groupBy dimension '${dim}'. Valid: ${VALID_GROUP_BY.join(", ")}`);
			}
		}

		// Validate timeUnit
		let timeUnit: TimeUnit | null = null;
		if (params.timeUnit) {
			const tu = params.timeUnit.toUpperCase() as TimeUnit;
			if (!VALID_TIME_UNITS.includes(tu)) {
				return yield* fail(`Unknown --timeUnit '${params.timeUnit}'. Valid: ${VALID_TIME_UNITS.join(", ")}`);
			}
			timeUnit = tu;
		}

		// Parse filter
		let filter: FilterExpr | null = null;
		if (params.filter) {
			filter = yield* parseFilter(params.filter);
		}

		const derived = params.derived ?? false;
		const nested = params.nested ?? false;

		// Resolve --when
		const range = yield* resolveWhen(params.when, sql);

		// Resolve --products
		let productAsins: string[] | null = null;
		if (params.products) {
			productAsins = yield* resolveProducts(params.products, sql);
			if (productAsins.length === 0) {
				return yield* fail("--products resolved to zero ASINs");
			}
		}

		// Get latest data date for the resolved stores
		const latestRow = yield* runCompiled(
			sql,
			() =>
				db
					.selectFrom("amzadapi_reports_v1__search_asin_placement__byDay")
					.select((eb) => eb.cast<string | null>(eb.fn.max("date"), "text").as("latest"))
					.where((eb) =>
						eb(
							eb.refTuple("merchantId", "marketplaceId"),
							"in",
							stores.map((s) => eb.tuple(s.merchantId, s.marketplaceId)),
						)
					)
					.compile(),
		);
		const dateDataLatest = latestRow[0]?.latest ?? range.dateLast;

		// Only the family dimension reads the family table, so only then is it probed.
		const familyTable = groupByDims.includes("family") ? (yield* probeFamilyTable(db, sql)) : false;

		// Build and run both statements. Each compiles its own parameter list, and a
		// non-empty list also puts them on the extended protocol, where stacked
		// statements are rejected.
		const [q1Rows, q2Rows] = yield* Effect.all([
			runCompiled(
				sql,
				yield* buildQuery1(db, stores, range, groupByDims, timeUnit, productAsins, filter, familyTable),
			),
			runCompiled(
				sql,
				yield* buildQuery2(db, stores, range, groupByDims, timeUnit, productAsins, filter, familyTable),
			),
		], { concurrency: 2 });

		// Merge results
		const data = mergeResults(
			q1Rows,
			q2Rows,
			groupByDims,
			timeUnit,
			derived,
			nested,
		);

		return {
			meta: {
				dateFirst: range.dateFirst,
				dateLast: range.dateLast,
				stores: stores.map((s) => s.countryCode),
				dateDataLatest,
				rowCount: data.length,
				groupBy: groupByDims,
				timeUnit,
				derived,
				nested,
			},
			data,
		};
	});
}
