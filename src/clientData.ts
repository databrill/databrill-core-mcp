/**
 * Client-DB data layer for the question tools — the portable, single-client
 * descendant of the agency repo's `lib/scripts/digest/_shared.ts`.
 *
 * Differences from the agency original (the only ones — the SQL and the
 * per-store merge/scope logic are copied verbatim so results match):
 *   • identity comes from the **client DB** (`amazon_merchant` / `amazon_store`),
 *     not a `clients/{alias}/client.json` file;
 *   • the connection (`sql`) is injected, not opened here;
 *   • marketplace facts come from the vendored zero-import `amazonConstants`.
 *
 * Reads the target client DB: `amzreport_ALL_ORDERS` (net sales),
 * `amzadapi_reports_v1__search_asin_placement__byDay` (ads), and the
 * `amazon_*` identity tables.
 */

import type { Sql } from "postgres";
import { DateTime } from "luxon";
import { countryCodeToMarketplaceInfo, marketplaceIdToMarketplaceInfo } from "./amazonConstants.ts";

// ─── identity (from the client DB) ──────────────────────────────────

/** Active merchant IDs for this client, from `amazon_merchant`. */
export async function discoverMerchantIds(sql: Sql): Promise<string[]> {
	const rows = await sql`
		SELECT "merchantId"
		FROM "amazon_merchant"
		WHERE "isActive" = true
		ORDER BY "merchantId"
	`;
	return rows.map((r) => String(r.merchantId));
}

/** Canonical-country set of the client's real, active stores, from `amazon_store`. */
export async function discoverConfiguredCountries(sql: Sql): Promise<Set<string>> {
	const rows = await sql`
		SELECT DISTINCT "countryCode"
		FROM "amazon_store"
		WHERE "isActive" = true AND "isReal" = true
	`;
	const set = new Set<string>();
	for (const r of rows) set.add(canonCountry(String(r.countryCode)));
	return set;
}

// ─── store identity helpers (verbatim from _shared) ─────────────────

/** Marketplace id → site code (uppercase, e.g. "US", "UK", "DE"). */
function siteOf(marketplaceId: string): string | null {
	return marketplaceIdToMarketplaceInfo[marketplaceId]?.countryCode ?? null;
}

/** Canonical store id, e.g. "AEXAMPLE123456-DE". */
function storeId(merchantId: string, site: string): string {
	return `${merchantId}-${site}`;
}

/**
 * Canonical key for a country code. Collapses the GB/UK split by resolving each
 * to its marketplaceId; unknown codes fall back to their uppercased selves.
 */
export function canonCountry(code: string): string {
	return countryCodeToMarketplaceInfo[code.toUpperCase()]?.marketplaceId ?? code.toUpperCase();
}

/**
 * Does store {merchantId, site} match a `--stores` token? Accepts a merchantId,
 * a country code, or `${merchantId}-${site}`. Country comparison is GB/UK-aware.
 */
function storeMatches(merchantId: string, site: string, token: string): boolean {
	const t = token.trim();
	if (!t) return false;
	if (t.toUpperCase() === merchantId.toUpperCase()) return true; // merchantId
	if (canonCountry(t) === canonCountry(site)) return true; // country (GB≡UK)
	const dash = t.lastIndexOf("-"); // merchantId-country
	if (dash > 0) {
		const m = t.slice(0, dash);
		const c = t.slice(dash + 1);
		if (m.toUpperCase() === merchantId.toUpperCase() && canonCountry(c) === canonCountry(site)) return true;
	}
	return false;
}

/**
 * Is a store in scope? `all` wins; an explicit `stores` list is matched by
 * token; otherwise the store's country must be in the configured set.
 */
export function storeInScope(
	merchantId: string,
	site: string,
	opts: { stores: string[] | null; configured: Set<string>; all: boolean },
): boolean {
	if (opts.all) return true;
	if (opts.stores) return opts.stores.some((t) => storeMatches(merchantId, site, t));
	return opts.configured.has(canonCountry(site));
}

/**
 * Display label per store: the bare country code when that country has a single
 * merchant in the set, else the full `${merchantId}-${site}`.
 */
function computeStoreLabels(stores: readonly { merchantId: string; site: string }[]): Map<string, string> {
	const merchantsPerSite = new Map<string, Set<string>>();
	for (const s of stores) {
		if (!merchantsPerSite.has(s.site)) merchantsPerSite.set(s.site, new Set());
		merchantsPerSite.get(s.site)!.add(s.merchantId);
	}
	const out = new Map<string, string>();
	for (const s of stores) {
		const multi = (merchantsPerSite.get(s.site)?.size ?? 1) > 1;
		out.set(storeId(s.merchantId, s.site), multi ? storeId(s.merchantId, s.site) : s.site);
	}
	return out;
}

// ─── daily rows ─────────────────────────────────────────────────────

interface DailySales {
	date: string;
	merchantId: string;
	site: string;
	currency: string;
	sales: number;
	units: number;
	orders: number;
}

interface DailySessions {
	date: string;
	merchantId: string;
	site: string;
	sessions: number;
}

interface DailyAd {
	date: string;
	merchantId: string;
	site: string;
	spend: number;
	clicks: number;
	impressions: number;
	orders: number;
	adSales: number;
}

function isoDate(d: string | Date): string {
	return typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

/**
 * Total daily sales per site since `since` (inclusive), from ALL_ORDERS.
 * Uses `item_price - item_promotion_discount` (net of coupons/deals).
 */
async function loadDailySalesBySite(sql: Sql, merchantIds: string[], since: string): Promise<DailySales[]> {
	const rows = await sql`
		SELECT
			"localdate" AS "date",
			"merchant_id" AS "merchantId",
			"marketplace_id" AS "marketplaceId",
			SUM("item_price" - COALESCE("item_promotion_discount", 0))::numeric AS "sales",
			MAX("currency") AS "currency",
			SUM("quantity")::int AS "units",
			COUNT(DISTINCT "amazon_order_id")::int AS "orders"
		FROM "amzreport_ALL_ORDERS"
		WHERE "merchant_id" = ANY(${merchantIds})
			AND "localdate" >= ${since}
			AND "localdate" < CURRENT_DATE
			AND "order_status" != 'Cancelled'
		GROUP BY "localdate", "merchant_id", "marketplace_id"
	`;
	const out: DailySales[] = [];
	for (const r of rows) {
		const site = siteOf(r.marketplaceId);
		if (!site) continue;
		out.push({
			date: isoDate(r.date),
			merchantId: r.merchantId,
			site,
			currency: r.currency ?? "",
			sales: Number(r.sales ?? 0),
			units: Number(r.units ?? 0),
			orders: Number(r.orders ?? 0),
		});
	}
	return out;
}

/** Daily advertising metrics per site since `since`, from the placement report. */
async function loadDailyAdBySite(sql: Sql, merchantIds: string[], since: string): Promise<DailyAd[]> {
	const rows = await sql`
		SELECT
			"date",
			"merchantId",
			"marketplaceId",
			SUM("totalCost")::numeric AS "spend",
			SUM("clicks")::int AS "clicks",
			SUM("impressions")::int AS "impressions",
			SUM("purchases")::int AS "orders",
			SUM("sales")::numeric AS "adSales"
		FROM "amzadapi_reports_v1__search_asin_placement__byDay"
		WHERE "merchantId" = ANY(${merchantIds})
			AND "date" >= ${since}
		GROUP BY "date", "merchantId", "marketplaceId"
	`;
	const out: DailyAd[] = [];
	for (const r of rows) {
		const site = siteOf(r.marketplaceId);
		if (!site) continue;
		out.push({
			date: isoDate(r.date),
			merchantId: r.merchantId,
			site,
			spend: Number(r.spend ?? 0),
			clicks: Number(r.clicks ?? 0),
			impressions: Number(r.impressions ?? 0),
			orders: Number(r.orders ?? 0),
			adSales: Number(r.adSales ?? 0),
		});
	}
	return out;
}

/**
 * Daily total sessions per site, from the Sales & Traffic report. Best-effort:
 * a client whose DB lacks the table (or the `traffic.sessions` field) degrades to
 * no session data, so the caller falls back to a price-only decomposition rather
 * than failing. Sales come from ALL_ORDERS (net, fresh); sessions only exist here.
 */
async function loadDailySessionsBySite(sql: Sql, merchantIds: string[], since: string): Promise<DailySessions[]> {
	try {
		const rows = await sql`
			SELECT
				"date",
				"merchantId",
				"marketplaceId",
				SUM(("traffic"->>'sessions')::int)::int AS "sessions"
			FROM "amzreport_SALES_AND_TRAFFIC__skuByDay"
			WHERE "merchantId" = ANY(${merchantIds})
				AND "date" >= ${since}
			GROUP BY "date", "merchantId", "marketplaceId"
		`;
		const out: DailySessions[] = [];
		for (const r of rows) {
			const site = siteOf(r.marketplaceId);
			if (!site) continue;
			out.push({
				date: isoDate(r.date),
				merchantId: r.merchantId,
				site,
				sessions: Number(r.sessions ?? 0),
			});
		}
		return out;
	} catch {
		return []; // table/field absent — sessions unavailable for this client
	}
}

// ─── per-site daily merge ───────────────────────────────────────────

/** Combined per-day metrics for one site (organic+ad sales and ad detail). */
export interface DayMetric {
	date: string;
	sales: number;
	units: number;
	orders: number;
	sessions: number;
	hasSessions: boolean; // Sales & Traffic reported sessions for this day
	spend: number;
	clicks: number;
	impressions: number;
	adOrders: number;
	adSales: number;
}

export interface StoreDaily {
	storeId: string;
	merchantId: string;
	site: string;
	label: string;
	currency: string;
	days: DayMetric[];
	asOf: string;
}

/**
 * Merge daily sales + daily ad into per-store ({merchantId, site}), date-sorted
 * series. Stores whose latest data is older than `maxStaleDays` are dropped.
 */
function mergeDaily(
	sales: DailySales[],
	ad: DailyAd[],
	sessions: DailySessions[],
	maxStaleDays = 14,
): StoreDaily[] {
	const staleCutoff = DateTime.now().minus({ days: maxStaleDays }).toISODate()!;
	interface Acc {
		merchantId: string;
		site: string;
		currency: string;
		byDate: Map<string, DayMetric>;
	}
	const byStore = new Map<string, Acc>();
	const ensure = (merchantId: string, site: string): Acc => {
		const id = storeId(merchantId, site);
		let e = byStore.get(id);
		if (!e) {
			e = { merchantId, site, currency: "", byDate: new Map() };
			byStore.set(id, e);
		}
		return e;
	};
	const day = (e: Acc, date: string): DayMetric => {
		let d = e.byDate.get(date);
		if (!d) {
			d = {
				date,
				sales: 0,
				units: 0,
				orders: 0,
				sessions: 0,
				hasSessions: false,
				spend: 0,
				clicks: 0,
				impressions: 0,
				adOrders: 0,
				adSales: 0,
			};
			e.byDate.set(date, d);
		}
		return d;
	};
	for (const s of sales) {
		const e = ensure(s.merchantId, s.site);
		if (s.currency) e.currency = s.currency;
		const d = day(e, s.date);
		d.sales += s.sales;
		d.units += s.units;
		d.orders += s.orders;
	}
	for (const s of sessions) {
		const e = ensure(s.merchantId, s.site);
		const d = day(e, s.date);
		d.sessions += s.sessions;
		d.hasSessions = true; // this day was reported by Sales & Traffic
	}
	for (const a of ad) {
		const e = ensure(a.merchantId, a.site);
		const d = day(e, a.date);
		d.spend += a.spend;
		d.clicks += a.clicks;
		d.impressions += a.impressions;
		d.adOrders += a.orders;
		d.adSales += a.adSales;
	}
	const kept: Acc[] = [];
	for (const e of byStore.values()) {
		if (e.byDate.size === 0) continue;
		const lastDate = [...e.byDate.keys()].sort().at(-1)!;
		if (lastDate < staleCutoff) continue; // long-dead marketplace
		kept.push(e);
	}
	const labels = computeStoreLabels(kept);
	const out: StoreDaily[] = kept.map((e) => {
		const days = [...e.byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
		return {
			storeId: storeId(e.merchantId, e.site),
			merchantId: e.merchantId,
			site: e.site,
			label: labels.get(storeId(e.merchantId, e.site)) ?? e.site,
			currency: e.currency,
			days,
			asOf: days[days.length - 1]!.date,
		};
	});
	out.sort((a, b) => sum(b.days, (d) => d.sales) - sum(a.days, (d) => d.sales));
	return out;
}

function sum<T>(rows: readonly T[], pick: (r: T) => number): number {
	return rows.reduce((s, r) => s + pick(r), 0);
}

/** ISO date `n` days before today (local), for query `since` bounds. */
export function sinceDaysAgo(n: number): string {
	return DateTime.now().minus({ days: n }).toISODate()!;
}

/** Load + merge the per-store daily series for this client. */
export async function loadStoreSeries(sql: Sql, merchantIds: string[], since: string): Promise<StoreDaily[]> {
	const [sales, ad, sessions] = await Promise.all([
		loadDailySalesBySite(sql, merchantIds, since),
		loadDailyAdBySite(sql, merchantIds, since),
		loadDailySessionsBySite(sql, merchantIds, since),
	]);
	return mergeDaily(sales, ad, sessions);
}
