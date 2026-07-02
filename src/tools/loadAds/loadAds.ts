import postgres from "postgres";
import { Either, Schema } from "effect";
import {
	type AmazonMarketplaceInfo,
	countryCodeToMarketplaceInfo,
	marketplaceIdToMarketplaceInfo,
	marketplaceInfos,
	regionCountryCodes,
} from "../../amazonConstants.ts";
import {
	parseWhenAst,
	type WhenAst_Duration,
} from "../../parseWhenAst.ts";

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
	dateFirst: string; // YYYY-MM-DD inclusive
	dateLast: string; // YYYY-MM-DD inclusive
}

export interface FilterExpr {
	field: string;
	op: string;
	value: string;
}

export const VALID_GROUP_BY = [
	"asin", "family", "parentAsin", "campaign", "adType",
	"placement", "target", "adgroup", "country", "store", "merchant", "marketplaceId",
] as const;
export type GroupByDim = typeof VALID_GROUP_BY[number];

export const VALID_TIME_UNITS = ["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"] as const;
export type TimeUnit = typeof VALID_TIME_UNITS[number];

const ASIN_PATTERN = /^B0[A-Z0-9]{8}$/i;
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

function fail(msg: string): never {
	throw new LoadAdsError(msg);
}

// ---------------------------------------------------------------------------
// Store Resolution
// ---------------------------------------------------------------------------

interface StoreRow {
	merchantId: string;
	marketplaceId: string;
	storeName: string;
}

// Resolve a bare scope token (no merchant qualifier) to marketplace infos.
// Supports '*', region keys (na/eu/fe), country codes, and marketplace IDs.
// Returns [] if the token isn't recognized as a scope.
function resolveScope(raw: string): AmazonMarketplaceInfo[] {
	const t = raw.trim();
	if (!t) return [];
	if (t === "*") return [...marketplaceInfos];
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
	if (byCc) return [byCc];
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
export async function resolveStores(spec: string, sql: postgres.Sql): Promise<ResolvedStore[]> {
	const rows = (await sql`
		SELECT "merchantId", "marketplaceId", "storeName"
		FROM amazon_store
		WHERE "isReal" AND "isActive"
	`) as unknown as StoreRow[];

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

	const seen = new Set<string>(); // `${merchantId}\x00${marketplaceId}`
	const result: ResolvedStore[] = [];

	const pushStore = (merchantId: string, merchantName: string, info: AmazonMarketplaceInfo) => {
		const key = `${merchantId}\x00${info.marketplaceId}`;
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
				fail(`Unknown merchant '${merchantId}' in store token '${token}'. Known merchants come from amazon_store.`);
			}
			const infos = resolveScope(scope);
			if (infos.length === 0) {
				fail(`Unknown store scope '${scope}' in token '${token}'. Valid: country codes, regions (na,eu,fe), marketplace IDs, or *.`);
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
				fail(`Unknown store '${token}'. Valid: country codes, regions (na,eu,fe), marketplace IDs, '*', or '{merchantId}-{scope}'.`);
			}
			for (const info of infos) {
				const ms = merchantsByMarketplace.get(info.marketplaceId) ?? [];
				for (const m of ms) pushStore(m.merchantId, m.merchantName, info);
			}
		}
	}

	if (result.length === 0) fail("No stores resolved (no active merchant sells in the requested marketplace[s])");
	return result;
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

// `(merchantId, marketplaceId) IN ((..),(..))` over the resolved stores.
function storePairsClause(stores: ResolvedStore[], merchantCol: string, marketplaceCol: string): string {
	const pairs = stores
		.map((s) => `('${s.merchantId}', '${s.marketplaceId}')`)
		.join(", ");
	return `(${merchantCol}, ${marketplaceCol}) IN (${pairs})`;
}

// ---------------------------------------------------------------------------
// When Resolution
// ---------------------------------------------------------------------------

function addDurationDays(dateStr: string, dur: WhenAst_Duration, sign: 1 | -1): string {
	const d = new Date(dateStr + "T00:00:00Z");
	if (dur.years) d.setUTCFullYear(d.getUTCFullYear() + sign * dur.years);
	if (dur.months) d.setUTCMonth(d.getUTCMonth() + sign * dur.months);
	if (dur.weeks) d.setUTCDate(d.getUTCDate() + sign * dur.weeks * 7);
	if (dur.days) d.setUTCDate(d.getUTCDate() + sign * dur.days);
	// Offset by 1 day to make both ends inclusive
	d.setUTCDate(d.getUTCDate() - sign * 1);
	return d.toISOString().slice(0, 10);
}

function extractDate(node: { readonly _tag: string; readonly date?: string; readonly datetime?: string }): string {
	if ("date" in node && node.date) return node.date;
	if ("datetime" in node && node.datetime) return node.datetime.slice(0, 10);
	throw new Error(`Cannot extract date from ${node._tag}`);
}

export async function resolveWhen(
	whenStr: string,
	sql: postgres.Sql,
): Promise<DateRange> {
	const parsed = parseWhenAst(whenStr);
	if (Either.isLeft(parsed)) {
		fail(`Invalid --when: ${parsed.left.message}`);
	}
	const ast = parsed.right;

	switch (ast._tag) {
		case "Interval_DateDate":
			return { dateFirst: ast.left.date, dateLast: ast.right.date };

		case "Interval_DateTimeDatetime":
			return {
				dateFirst: ast.left.datetime.slice(0, 10),
				dateLast: ast.right.datetime.slice(0, 10),
			};

		case "Interval_DateDuration": {
			const from = extractDate(ast.left);
			const to = addDurationDays(from, ast.right, 1);
			return { dateFirst: from, dateLast: to };
		}

		case "Interval_DurationDate": {
			const to = extractDate(ast.right);
			const from = addDurationDays(to, ast.left, -1);
			return { dateFirst: from, dateLast: to };
		}

		case "Duration": {
			// Duration alone: end = latest data date
			const latestRow = await sql`
				SELECT MAX(date)::text AS latest
				FROM "amzadapi_reports_v1__search_asin_placement__byDay"
			`;
			const latest = latestRow[0]?.latest;
			if (!latest) fail("No ad data found in database");
			const from = addDurationDays(latest, ast, -1);
			return { dateFirst: from, dateLast: latest };
		}

		default:
			fail(`Unsupported --when format: ${ast._tag}`);
	}
}

// ---------------------------------------------------------------------------
// Products Resolution
// ---------------------------------------------------------------------------

export async function resolveProducts(
	productsStr: string,
	sql: postgres.Sql,
): Promise<string[]> {
	const tokens = productsStr.split(",").map((s) => s.trim()).filter(Boolean);
	const childAsins = new Set<string>();

	for (const token of tokens) {
		if (ASIN_PATTERN.test(token)) {
			// Check if parent ASIN -> expand to children
			const children = await sql`
				SELECT asin
				FROM "amzspapi_catalog_items_v20220401__catalogitem"
				WHERE parent_asin = ${token}
			`;
			if (children.length > 0) {
				for (const row of children) childAsins.add(row.asin);
			} else {
				// Treat as child ASIN directly
				childAsins.add(token);
			}
		} else {
			// Family name lookup
			const rows = await sql`
				SELECT asin
				FROM brand_config_amazon_asin
				WHERE family = ${token}
			`;
			if (rows.length === 0) {
				console.error(`Warning: no ASINs found for family '${token}'`);
			}
			for (const row of rows) childAsins.add(row.asin);
		}
	}

	return [...childAsins];
}

// ---------------------------------------------------------------------------
// Filter Parsing
// ---------------------------------------------------------------------------

function parseFilter(filterStr: string): FilterExpr {
	const parts = filterStr.split(":");
	if (parts.length < 3) fail(`Invalid --filter format: '${filterStr}'. Expected 'field:op:value'`);
	const field = parts[0];
	const op = parts[1];
	const value = parts.slice(2).join(":");
	if (op !== "=") fail(`Unsupported filter operator '${op}'. Only '=' is supported`);
	if (field !== "campaignName") fail(`Unsupported filter field '${field}'. Only 'campaignName' is supported`);
	return { field, op, value };
}

// ---------------------------------------------------------------------------
// SQL Building Helpers
// ---------------------------------------------------------------------------

function timeUnitSelectExprs(tu: TimeUnit): string[] {
	switch (tu) {
		case "DAY":
			return [
				`r.date::text AS "dateFirst"`,
				`r.date::text AS "dateLast"`,
			];
		case "WEEK":
			return [
				`to_char(date_trunc('week', r.date), 'YYYY-MM-DD') AS "dateFirst"`,
				`to_char(date_trunc('week', r.date) + INTERVAL '6 days', 'YYYY-MM-DD') AS "dateLast"`,
			];
		case "MONTH":
			return [
				`to_char(date_trunc('month', r.date), 'YYYY-MM-DD') AS "dateFirst"`,
				`to_char(date_trunc('month', r.date) + INTERVAL '1 month' - INTERVAL '1 day', 'YYYY-MM-DD') AS "dateLast"`,
			];
		case "QUARTER":
			return [
				`to_char(date_trunc('quarter', r.date), 'YYYY-MM-DD') AS "dateFirst"`,
				`to_char(date_trunc('quarter', r.date) + INTERVAL '3 months' - INTERVAL '1 day', 'YYYY-MM-DD') AS "dateLast"`,
			];
		case "YEAR":
			return [
				`to_char(date_trunc('year', r.date), 'YYYY-MM-DD') AS "dateFirst"`,
				`to_char(date_trunc('year', r.date) + INTERVAL '1 year' - INTERVAL '1 day', 'YYYY-MM-DD') AS "dateLast"`,
			];
	}
}

function timeUnitGroupBy(tu: TimeUnit): string {
	switch (tu) {
		case "DAY":
			return `r.date`;
		case "WEEK":
			return `date_trunc('week', r.date)`;
		case "MONTH":
			return `date_trunc('month', r.date)`;
		case "QUARTER":
			return `date_trunc('quarter', r.date)`;
		case "YEAR":
			return `date_trunc('year', r.date)`;
	}
}

const TIME_UNIT_OUTPUT_COLS = ["dateFirst", "dateLast"];

// Build resolved ASIN expression for the main query
// Handles SB ASIN resolution via sb_asin_lookup CTE
function resolvedAsinExpr(): string {
	return `COALESCE(
		NULLIF(r."advertisedProductId", ''),
		sb_lookup.first_asin,
		'${UNRESOLVED_ASIN}'
	)`;
}

// Same for product01 (halo-in uses convertedProductId as the asin)
function resolvedAsinExprProduct01(): string {
	return `r."convertedProductId"`;
}

// ---------------------------------------------------------------------------
// groupBy -> SQL mapping for the search_asin_placement query
// ---------------------------------------------------------------------------

interface DimSql {
	selectExprs: string[];
	groupByExprs: string[];
	outputCols: string[];
	needsCampaignJoin: boolean;
	needsAdJoin: boolean;
	needsFamilyJoin: boolean;
	needsParentAsinJoin: boolean;
}

function buildDimSql(
	dims: GroupByDim[],
	stores: ResolvedStore[],
	tableAlias: "r",
	isHaloIn: boolean,
): DimSql {
	const selectExprs: string[] = [];
	const groupByExprs: string[] = [];
	const outputCols: string[] = [];
	let needsCampaignJoin = false;
	let needsAdJoin = false;
	let needsFamilyJoin = false;
	let needsParentAsinJoin = false;

	const resolvedAsin = isHaloIn ? resolvedAsinExprProduct01() : resolvedAsinExpr();

	for (const dim of dims) {
		switch (dim) {
			case "asin":
				selectExprs.push(`${resolvedAsin} AS "asin"`);
				groupByExprs.push(resolvedAsin);
				outputCols.push("asin");
				break;
			case "family":
				needsFamilyJoin = true;
				selectExprs.push(`fam.family AS "family"`);
				groupByExprs.push(`fam.family`);
				outputCols.push("family");
				break;
			case "parentAsin":
				needsParentAsinJoin = true;
				selectExprs.push(`cat.parent_asin AS "parentAsin"`);
				groupByExprs.push(`cat.parent_asin`);
				outputCols.push("parentAsin");
				break;
			case "campaign":
				needsCampaignJoin = true;
				selectExprs.push(`${tableAlias}."campaignId" AS "campaignId"`);
				selectExprs.push(`camp.name AS "campaignName"`);
				groupByExprs.push(`${tableAlias}."campaignId"`, `camp.name`);
				outputCols.push("campaignId", "campaignName");
				break;
			case "adType":
				needsCampaignJoin = true;
				needsAdJoin = true;
				selectExprs.push(`
					CASE
						WHEN camp."adProduct" = 'SPONSORED_PRODUCTS' THEN 'SP'
						WHEN camp."adProduct" = 'SPONSORED_DISPLAY' THEN 'SD'
						WHEN camp."adProduct" IN ('SPONSORED_BRANDS', 'SPONSORED_BRANDS_VIDEO') THEN
							CASE
								WHEN ad."adType" IN ('VIDEO', 'BRAND_VIDEO') THEN 'SBV'
								ELSE 'SB'
							END
						WHEN ${tableAlias}."adProduct" = 'Sponsored Products' THEN 'SP'
						WHEN ${tableAlias}."adProduct" = 'Sponsored Display' THEN 'SD'
						WHEN ${tableAlias}."adProduct" = 'Sponsored Brands' THEN
							CASE
								WHEN ad."adType" IN ('VIDEO', 'BRAND_VIDEO') THEN 'SBV'
								ELSE 'SB'
							END
						ELSE COALESCE(camp."adProduct", ${tableAlias}."adProduct")
					END AS "adType"`);
				groupByExprs.push(
					`camp."adProduct"`,
					`ad."adType"`,
					`${tableAlias}."adProduct"`,
				);
				outputCols.push("adType");
				break;
			case "placement":
				selectExprs.push(`${tableAlias}."placementClassification" AS "placement"`);
				groupByExprs.push(`${tableAlias}."placementClassification"`);
				outputCols.push("placement");
				break;
			case "target":
				selectExprs.push(`${tableAlias}.target AS "target"`);
				groupByExprs.push(`${tableAlias}.target`);
				outputCols.push("target");
				break;
			case "adgroup":
				selectExprs.push(`${tableAlias}."adGroupId" AS "adGroupId"`);
				groupByExprs.push(`${tableAlias}."adGroupId"`);
				outputCols.push("adGroupId");
				break;
			case "country": {
				// Map marketplaceId -> country via CASE
				const whenClauses = distinctMarketplaces(stores)
					.map((s) => `WHEN ${tableAlias}."marketplaceId" = '${s.marketplaceId}' THEN '${s.countryCode}'`)
					.join(" ");
				selectExprs.push(`CASE ${whenClauses} END AS "country"`);
				groupByExprs.push(`${tableAlias}."marketplaceId"`);
				outputCols.push("country");
				break;
			}
			case "store": {
				// Storefront label per marketplace (e.g. Amazon.de)
				const whenClauses = distinctMarketplaces(stores)
					.map((s) => `WHEN ${tableAlias}."marketplaceId" = '${s.marketplaceId}' THEN '${s.storeName}'`)
					.join(" ");
				selectExprs.push(`CASE ${whenClauses} END AS "store"`);
				groupByExprs.push(`${tableAlias}."marketplaceId"`);
				outputCols.push("store");
				break;
			}
			case "merchant": {
				// Seller account: merchantId + its amazon_store name
				const whenClauses = distinctMerchants(stores)
					.map((s) => `WHEN ${tableAlias}."merchantId" = '${s.merchantId}' THEN '${s.merchantName.replace(/'/g, "''")}'`)
					.join(" ");
				selectExprs.push(`${tableAlias}."merchantId" AS "merchantId"`);
				selectExprs.push(`CASE ${whenClauses} END AS "merchantName"`);
				groupByExprs.push(`${tableAlias}."merchantId"`);
				outputCols.push("merchantId", "merchantName");
				break;
			}
			case "marketplaceId":
				selectExprs.push(`${tableAlias}."marketplaceId" AS "marketplaceId"`);
				groupByExprs.push(`${tableAlias}."marketplaceId"`);
				outputCols.push("marketplaceId");
				break;
		}
	}

	return { selectExprs, groupByExprs, outputCols, needsCampaignJoin, needsAdJoin, needsFamilyJoin, needsParentAsinJoin };
}

// ---------------------------------------------------------------------------
// Currency mapping: always add currency to output
// ---------------------------------------------------------------------------

function currencyCaseExpr(stores: ResolvedStore[], alias: string): string {
	const currencies = new Set(stores.map((s) => s.currency));
	if (currencies.size <= 1) {
		const only = stores[0]?.currency ?? "";
		return `'${only}' AS "currency"`;
	}
	const whenClauses = distinctMarketplaces(stores)
		.map((s) => `WHEN ${alias}."marketplaceId" = '${s.marketplaceId}' THEN '${s.currency}'`)
		.join(" ");
	return `CASE ${whenClauses} END AS "currency"`;
}

// ---------------------------------------------------------------------------
// Query 1: Advertised + Halo-out (search_asin_placement__byDay)
// ---------------------------------------------------------------------------

function buildQuery1(
	stores: ResolvedStore[],
	range: DateRange,
	dims: GroupByDim[],
	timeUnit: TimeUnit | null,
	productAsins: string[] | null,
	filter: FilterExpr | null,
): string {
	const dimSql = buildDimSql(dims, stores, "r", false);

	// sb_asin_lookup CTE
	const sbCte = `sb_asin_lookup AS (
		SELECT "adId", "marketplaceId",
			COALESCE(
				"creative"->'products'->0->>'productId',
				"creative"->'asins'->>0
			) AS first_asin
		FROM "amzadapi_exports_v1__ad"
		WHERE ${storePairsClause(stores, `"merchantId"`, `"marketplaceId"`)}
			AND "adProduct" IN ('SPONSORED_BRANDS', 'SPONSORED_BRANDS_VIDEO')
	)`;

	// SELECT columns
	const selectCols: string[] = [];
	selectCols.push(currencyCaseExpr(stores, "r"));
	if (timeUnit) selectCols.push(...timeUnitSelectExprs(timeUnit));
	selectCols.push(...dimSql.selectExprs);

	// Advertised metrics
	selectCols.push(
		`SUM(r.impressions) AS "impressions"`,
		`SUM(r.clicks) AS "clicks"`,
		`SUM(r."addToCart") AS "addToCart"`,
		`SUM(r.purchases) AS "purchases"`,
		`SUM(r."unitsSold") AS "units"`,
		`SUM(r."totalCost"::float) AS "spend"`,
		`SUM(r.sales::float) AS "revenue"`,
	);

	// Halo-out metrics
	selectCols.push(
		`SUM(r."purchasesHalo") AS "purchasesHaloOut"`,
		`SUM(r."unitsSoldHalo") AS "unitsHaloOut"`,
		`SUM(r."salesHalo"::float) AS "revenueHaloOut"`,
	);

	// FROM + JOINs
	let fromClause = `FROM "amzadapi_reports_v1__search_asin_placement__byDay" r`;
	fromClause += `\nLEFT JOIN sb_asin_lookup sb_lookup ON r."adId" = sb_lookup."adId" AND r."marketplaceId" = sb_lookup."marketplaceId"`;

	if (dimSql.needsCampaignJoin) {
		fromClause += `\nLEFT JOIN "amzadapi_exports_v1__campaign" camp ON r."campaignId" = camp."campaignId" AND r."merchantId" = camp."merchantId" AND r."marketplaceId" = camp."marketplaceId"`;
	}
	if (dimSql.needsAdJoin) {
		fromClause += `\nLEFT JOIN "amzadapi_exports_v1__ad" ad ON r."adId" = ad."adId" AND r."merchantId" = ad."merchantId" AND r."marketplaceId" = ad."marketplaceId"`;
	}
	if (dimSql.needsFamilyJoin) {
		fromClause += `\nLEFT JOIN brand_config_amazon_asin fam ON fam.asin = ${resolvedAsinExpr()}`;
	}
	if (dimSql.needsParentAsinJoin) {
		fromClause += `\nLEFT JOIN "amzspapi_catalog_items_v20220401__catalogitem" cat ON cat.asin = ${resolvedAsinExpr()}`;
	}

	// WHERE
	const wheres: string[] = [
		storePairsClause(stores, `r."merchantId"`, `r."marketplaceId"`),
		`r.date >= '${range.dateFirst}'`,
		`r.date <= '${range.dateLast}'`,
	];
	if (productAsins) {
		wheres.push(`${resolvedAsinExpr()} IN (${productAsins.map((a) => `'${a}'`).join(",")})`);
	}
	if (filter) {
		if (dimSql.needsCampaignJoin) {
			wheres.push(`camp.name = '${filter.value.replace(/'/g, "''")}'`);
		} else {
			// Need to add campaign join for filter
			fromClause += `\nLEFT JOIN "amzadapi_exports_v1__campaign" camp_filt ON r."campaignId" = camp_filt."campaignId" AND r."merchantId" = camp_filt."merchantId" AND r."marketplaceId" = camp_filt."marketplaceId"`;
			wheres.push(`camp_filt.name = '${filter.value.replace(/'/g, "''")}'`);
		}
	}

	// GROUP BY
	const groupByCols: string[] = [];
	// Currency grouping (for multi-store)
	if (distinctMarketplaces(stores).length > 1) groupByCols.push(`r."marketplaceId"`);
	if (timeUnit) groupByCols.push(timeUnitGroupBy(timeUnit));
	groupByCols.push(...dimSql.groupByExprs);

	// Deduplicate group by
	const uniqueGroupBy = [...new Set(groupByCols)];

	return `WITH ${sbCte}\nSELECT\n  ${selectCols.join(",\n  ")}\n${fromClause}\nWHERE ${wheres.join("\n  AND ")}\nGROUP BY ${uniqueGroupBy.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Query 2: Halo-in (product01__byDay)
// ---------------------------------------------------------------------------

function buildQuery2(
	stores: ResolvedStore[],
	range: DateRange,
	dims: GroupByDim[],
	timeUnit: TimeUnit | null,
	productAsins: string[] | null,
	filter: FilterExpr | null,
): string {
	// For halo-in, the ASIN is convertedProductId (which product received the halo)
	// We still need sb_asin_lookup for dimensions that depend on the advertised product
	const dimSql = buildDimSql(dims, stores, "r", true);

	const sbCte = `sb_asin_lookup AS (
		SELECT "adId", "marketplaceId",
			COALESCE(
				"creative"->'products'->0->>'productId',
				"creative"->'asins'->>0
			) AS first_asin
		FROM "amzadapi_exports_v1__ad"
		WHERE ${storePairsClause(stores, `"merchantId"`, `"marketplaceId"`)}
			AND "adProduct" IN ('SPONSORED_BRANDS', 'SPONSORED_BRANDS_VIDEO')
	)`;

	const selectCols: string[] = [];
	selectCols.push(currencyCaseExpr(stores, "r"));
	if (timeUnit) selectCols.push(...timeUnitSelectExprs(timeUnit));
	selectCols.push(...dimSql.selectExprs);

	// Halo-in metrics
	selectCols.push(
		`SUM(r.purchases) AS "purchasesHaloIn"`,
		`SUM(r."unitsSold") AS "unitsHaloIn"`,
		`SUM(r.sales::float) AS "revenueHaloIn"`,
	);

	let fromClause = `FROM "amzadapi_reports_v1__product01__byDay" r`;
	fromClause += `\nLEFT JOIN sb_asin_lookup sb_lookup ON r."adId" = sb_lookup."adId" AND r."marketplaceId" = sb_lookup."marketplaceId"`;

	if (dimSql.needsCampaignJoin) {
		fromClause += `\nLEFT JOIN "amzadapi_exports_v1__campaign" camp ON r."campaignId" = camp."campaignId" AND r."merchantId" = camp."merchantId" AND r."marketplaceId" = camp."marketplaceId"`;
	}
	if (dimSql.needsAdJoin) {
		fromClause += `\nLEFT JOIN "amzadapi_exports_v1__ad" ad ON r."adId" = ad."adId" AND r."merchantId" = ad."merchantId" AND r."marketplaceId" = ad."marketplaceId"`;
	}
	if (dimSql.needsFamilyJoin) {
		// For halo-in, family is on the converted product (the one that received halo)
		fromClause += `\nLEFT JOIN brand_config_amazon_asin fam ON fam.asin = ${resolvedAsinExprProduct01()}`;
	}
	if (dimSql.needsParentAsinJoin) {
		fromClause += `\nLEFT JOIN "amzspapi_catalog_items_v20220401__catalogitem" cat ON cat.asin = ${resolvedAsinExprProduct01()}`;
	}

	const wheres: string[] = [
		storePairsClause(stores, `r."merchantId"`, `r."marketplaceId"`),
		`r.date >= '${range.dateFirst}'`,
		`r.date <= '${range.dateLast}'`,
		`r."productRelevance" = 'Brand halo'`,
	];
	if (productAsins) {
		wheres.push(`${resolvedAsinExprProduct01()} IN (${productAsins.map((a) => `'${a}'`).join(",")})`);
	}
	if (filter) {
		if (dimSql.needsCampaignJoin) {
			wheres.push(`camp.name = '${filter.value.replace(/'/g, "''")}'`);
		} else {
			fromClause += `\nLEFT JOIN "amzadapi_exports_v1__campaign" camp_filt ON r."campaignId" = camp_filt."campaignId" AND r."merchantId" = camp_filt."merchantId" AND r."marketplaceId" = camp_filt."marketplaceId"`;
			wheres.push(`camp_filt.name = '${filter.value.replace(/'/g, "''")}'`);
		}
	}

	const groupByCols: string[] = [];
	if (distinctMarketplaces(stores).length > 1) groupByCols.push(`r."marketplaceId"`);
	if (timeUnit) groupByCols.push(timeUnitGroupBy(timeUnit));
	groupByCols.push(...dimSql.groupByExprs);

	const uniqueGroupBy = [...new Set(groupByCols)];

	return `WITH ${sbCte}\nSELECT\n  ${selectCols.join(",\n  ")}\n${fromClause}\nWHERE ${wheres.join("\n  AND ")}\nGROUP BY ${uniqueGroupBy.join(", ")}`;
}

// ---------------------------------------------------------------------------
// In-memory Merge
// ---------------------------------------------------------------------------

function buildMergeKey(row: Record<string, unknown>, keyCols: string[]): string {
	return keyCols.map((c) => String(row[c] ?? "")).join("\x00");
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
	const dimSqlRef = buildDimSql(dims, [], "r", false);
	keyCols.push(...dimSqlRef.outputCols);

	// Pre-aggregate: SQL groups by raw camp/ad/r columns, but the CASE
	// expressions (e.g. adType) collapse multiple raw groups into one output
	// label. Merge those collisions by summing numeric columns; otherwise
	// later Map-based indexing would silently drop all but the last colliding
	// row. See benchmark notes 2026-04-25 for the SBV / BRAND_VIDEO case.
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
		const impressions = isQ1 ? Number(q1Row.impressions ?? 0) : 0;
		const clicks = isQ1 ? Number(q1Row.clicks ?? 0) : 0;
		const addToCart = isQ1 ? Number(q1Row.addToCart ?? 0) : 0;
		const purchases = isQ1 ? Number(q1Row.purchases ?? 0) : 0;
		const units = isQ1 ? Number(q1Row.units ?? 0) : 0;
		const spend = isQ1 ? Number(q1Row.spend ?? 0) : 0;
		const revenue = isQ1 ? Number(q1Row.revenue ?? 0) : 0;

		// Halo-out (from q1)
		const purchasesHaloOut = isQ1 ? Number(q1Row.purchasesHaloOut ?? 0) : 0;
		const unitsHaloOut = isQ1 ? Number(q1Row.unitsHaloOut ?? 0) : 0;
		const revenueHaloOut = isQ1 ? Number(q1Row.revenueHaloOut ?? 0) : 0;

		// Halo-in (from q2)
		const purchasesHaloIn = q2Row ? Number(q2Row.purchasesHaloIn ?? 0) : 0;
		const unitsHaloIn = q2Row ? Number(q2Row.unitsHaloIn ?? 0) : 0;
		const revenueHaloIn = q2Row ? Number(q2Row.revenueHaloIn ?? 0) : 0;

		if (nestedFlag) {
			outRow.adStats = {
				impressions,
				clicks,
				addToCart,
				purchases,
				units,
				spend: round2(spend),
				revenue: round2(revenue),
			};
			outRow.adStatsHaloOut = {
				impressions: null,
				clicks: null,
				addToCart: null,
				purchases: purchasesHaloOut,
				units: unitsHaloOut,
				spend: null,
				revenue: round2(revenueHaloOut),
			};
			outRow.adStatsHaloIn = {
				impressions: null,
				clicks: null,
				addToCart: null,
				purchases: purchasesHaloIn,
				units: unitsHaloIn,
				spend: null,
				revenue: round2(revenueHaloIn),
			};
		} else {
			outRow.impressions = impressions;
			outRow.clicks = clicks;
			outRow.addToCart = addToCart;
			outRow.purchases = purchases;
			outRow.units = units;
			outRow.spend = round2(spend);
			outRow.revenue = round2(revenue);
			outRow.purchasesHaloOut = purchasesHaloOut;
			outRow.unitsHaloOut = unitsHaloOut;
			outRow.revenueHaloOut = round2(revenueHaloOut);
			outRow.purchasesHaloIn = purchasesHaloIn;
			outRow.unitsHaloIn = unitsHaloIn;
			outRow.revenueHaloIn = round2(revenueHaloIn);
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
				outRow.derived = derived;
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

export async function loadAds(
	params: LoadAdsParams,
	sql: postgres.Sql,
): Promise<LoadAdsResult> {
	// Validate required fields
	if (!params.stores) fail("--stores is required");
	if (!params.when) fail("--when is required");
	if (!params.groupBy) fail("--groupBy is required");

	// Resolve stores (merchant <-> marketplace mapping comes from amazon_store)
	const stores = await resolveStores(params.stores, sql);

	// Validate groupBy
	const groupByDims = params.groupBy.split(",").map((s) => s.trim()) as GroupByDim[];
	for (const dim of groupByDims) {
		if (!VALID_GROUP_BY.includes(dim)) {
			fail(`Unknown --groupBy dimension '${dim}'. Valid: ${VALID_GROUP_BY.join(", ")}`);
		}
	}

	// Validate timeUnit
	let timeUnit: TimeUnit | null = null;
	if (params.timeUnit) {
		const tu = params.timeUnit.toUpperCase() as TimeUnit;
		if (!VALID_TIME_UNITS.includes(tu)) {
			fail(`Unknown --timeUnit '${params.timeUnit}'. Valid: ${VALID_TIME_UNITS.join(", ")}`);
		}
		timeUnit = tu;
	}

	// Parse filter
	let filter: FilterExpr | null = null;
	if (params.filter) {
		filter = parseFilter(params.filter);
	}

	const derived = params.derived ?? false;
	const nested = params.nested ?? false;

	// Resolve --when
	const range = await resolveWhen(params.when, sql);

	// Resolve --products
	let productAsins: string[] | null = null;
	if (params.products) {
		productAsins = await resolveProducts(params.products, sql);
		if (productAsins.length === 0) {
			fail("--products resolved to zero ASINs");
		}
	}

	// Get latest data date for the resolved stores
	const latestRow = await sql.unsafe(`
		SELECT MAX(date)::text AS latest
		FROM "amzadapi_reports_v1__search_asin_placement__byDay"
		WHERE ${storePairsClause(stores, `"merchantId"`, `"marketplaceId"`)}
	`) as Array<{ latest: string | null }>;
	const dateDataLatest = latestRow[0]?.latest ?? range.dateLast;

	// Build and run queries
	const q1Sql = buildQuery1(stores, range, groupByDims, timeUnit, productAsins, filter);
	const q2Sql = buildQuery2(stores, range, groupByDims, timeUnit, productAsins, filter);

	const [q1Rows, q2Rows] = await Promise.all([
		sql.unsafe(q1Sql) as Promise<Record<string, unknown>[]>,
		sql.unsafe(q2Sql) as Promise<Record<string, unknown>[]>,
	]);

	// Merge results
	const data = mergeResults(
		q1Rows as Record<string, unknown>[],
		q2Rows as Record<string, unknown>[],
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
}
