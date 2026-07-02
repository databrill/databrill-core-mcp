/**
 * Sales-drop diagnosis — data load and cause ranking.
 *
 * Ported from the agency repo `lib/reports/salesDropDiagnosis/load.ts`. The
 * decomposition and signal math are copied verbatim; the only changes are:
 *   • the per-store daily series comes from the portable `clientData` layer
 *     (injected `sql`, DB-discovered identity) instead of the digest `_shared`;
 *   • the low-runway inventory flags/signal are sourced from the client-DB
 *     `loadLowInventory` (the same query the `inventoryPacing` tool uses) rather
 *     than the agency `lowInventory` report — no agency-table dependency.
 */

import { Effect } from "effect";
import type { Sql } from "postgres";
import {
	discoverConfiguredCountries,
	discoverMerchantIds,
	loadStoreSeries,
	sinceDaysAgo,
	storeInScope,
} from "../../clientData.ts";
import type { DayMetric } from "../../clientData.ts";
import { countryCodeToMarketplaceInfo } from "../../amazonConstants.ts";
import type { ResolvedStore } from "../loadAds/loadAds.ts";
import { loadLowInventory } from "../inventoryPacing/lowInventory.ts";
import type { LowInventoryRow } from "../inventoryPacing/types.ts";
import type { ContributingSignal, DropCause, InventoryFlag, LoadConfig, StoreDiagnosis, WindowAgg } from "./types.ts";

function emptyWindow(): WindowAgg {
	return {
		days: 0,
		dateFirst: "",
		dateLast: "",
		sales: 0,
		units: 0,
		orders: 0,
		sessions: 0,
		sessionDays: 0,
		sessionUnits: 0,
		spend: 0,
		clicks: 0,
		adOrders: 0,
		adSales: 0,
		salesPerDay: 0,
		sessionsPerDay: null,
		unitConversion: null,
		asp: null,
		adSalesPerDay: 0,
		organicSalesPerDay: 0,
		adCr: null,
		cpc: null,
	};
}

function aggregate(days: DayMetric[]): WindowAgg {
	const w = emptyWindow();
	w.days = days.length;
	for (const d of days) {
		w.sales += d.sales;
		w.units += d.units;
		w.orders += d.orders;
		w.sessions += d.sessions;
		// Sessions (Sales & Traffic) lag the fresh ALL_ORDERS sales by a day or
		// two, so accumulate the session-based factors only over days that have
		// session data, keeping traffic and conversion aligned with each other.
		if (d.hasSessions) {
			w.sessionDays += 1;
			w.sessionUnits += d.units;
		}
		w.spend += d.spend;
		w.clicks += d.clicks;
		w.adOrders += d.adOrders;
		w.adSales += d.adSales;
		if (!w.dateFirst || d.date < w.dateFirst) w.dateFirst = d.date;
		if (!w.dateLast || d.date > w.dateLast) w.dateLast = d.date;
	}
	const n = Math.max(1, w.days);
	w.salesPerDay = w.sales / n;
	// Traffic and conversion are per session-covered day (not the full window),
	// so they stay aligned; price/ASP and salesPerDay use all days (fresh).
	w.sessionsPerDay = w.sessionDays > 0 ? w.sessions / w.sessionDays : null;
	w.unitConversion = w.sessions > 0 ? w.sessionUnits / w.sessions : null;
	w.asp = w.units > 0 ? w.sales / w.units : null;
	w.adSalesPerDay = w.adSales / n;
	w.organicSalesPerDay = (w.sales - w.adSales) / n;
	w.adCr = w.clicks > 0 ? w.adOrders / w.clicks : null;
	w.cpc = w.clicks > 0 ? w.spend / w.clicks : null;
	return w;
}

/** Log-contribution of a factor that moved from `b` to `r`; null if either is non-positive. */
function logDelta(b: number | null, r: number | null): number | null {
	if (b == null || r == null || b <= 0 || r <= 0) return null;
	return Math.log(r) - Math.log(b);
}

function directionOf(b: number | null, r: number | null): DropCause["direction"] {
	if (b == null || r == null) return "n/a";
	if (b === 0) return r === 0 ? "flat" : "rose";
	const rel = (r - b) / Math.abs(b);
	if (rel > 0.02) return "rose";
	if (rel < -0.02) return "fell";
	return "flat";
}

/** Signed relative change, e.g. "-30%". */
function fmtPct(v: number | null): string {
	return v == null ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;
}

/** Unsigned level percentage, e.g. "12.3%". */
function fmtLevelPct(v: number | null): string {
	return v == null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number | null, digits = 0): string {
	if (v == null) return "n/a";
	return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtMoney(v: number | null): string {
	return v == null ? "n/a" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function relChange(b: number | null, r: number | null): number | null {
	if (b == null || r == null || b === 0) return null;
	return (r - b) / Math.abs(b);
}

function buildCauses(b: WindowAgg, r: WindowAgg, totalLog: number | null, sessionsKnown: boolean): DropCause[] {
	const causes: DropCause[] = [];

	if (sessionsKnown) {
		causes.push(makeCause(
			"traffic",
			"Traffic (sessions/day)",
			b.sessionsPerDay,
			r.sessionsPerDay,
			totalLog,
			`${fmtNum(b.sessionsPerDay)} → ${fmtNum(r.sessionsPerDay)} sessions/day (${
				fmtPct(relChange(b.sessionsPerDay, r.sessionsPerDay))
			})`,
		));
		causes.push(makeCause(
			"conversion",
			"Conversion (units/session)",
			b.unitConversion,
			r.unitConversion,
			totalLog,
			`${fmtLevelPct(b.unitConversion)} → ${fmtLevelPct(r.unitConversion)} units/session (${
				fmtPct(relChange(b.unitConversion, r.unitConversion))
			})`,
		));
	}

	causes.push(makeCause(
		"price",
		"Price (avg selling price/unit)",
		b.asp,
		r.asp,
		totalLog,
		`${fmtMoney(b.asp)} → ${fmtMoney(r.asp)} per unit (${fmtPct(relChange(b.asp, r.asp))})`,
	));

	// Largest absolute mover first; null contributions sink to the bottom.
	causes.sort((a, c) => Math.abs(c.contribution ?? 0) - Math.abs(a.contribution ?? 0));
	return causes;
}

function makeCause(
	key: DropCause["key"],
	label: string,
	baseline: number | null,
	recent: number | null,
	totalLog: number | null,
	evidence: string,
): DropCause {
	const contribution = logDelta(baseline, recent);
	// Shares are only meaningful when the overall move is large enough to attribute;
	// near-flat stores produce wild shares (a tiny denominator), so suppress them.
	const shareIsStable = totalLog != null && Math.abs(totalLog) >= 0.1;
	return {
		key,
		label,
		contribution,
		approxPctEffect: contribution == null ? null : Math.exp(contribution) - 1,
		share: contribution != null && shareIsStable ? contribution / totalLog! : null,
		direction: directionOf(baseline, recent),
		baseline,
		recent,
		evidence,
	};
}

function buildSignals(b: WindowAgg, r: WindowAgg, currency: string): ContributingSignal[] {
	const signals: ContributingSignal[] = [];
	const cur = currency ? `${currency} ` : "";

	// Channel split — did the drop come from ads or organic?
	const adChange = relChange(b.adSalesPerDay, r.adSalesPerDay);
	const orgChange = relChange(b.organicSalesPerDay, r.organicSalesPerDay);
	const adDrop = r.adSalesPerDay - b.adSalesPerDay;
	const orgDrop = r.organicSalesPerDay - b.organicSalesPerDay;
	if (adChange != null) {
		signals.push({
			key: "ad-channel",
			label: "Ad-attributed sales",
			severity: adChange < -0.15 ? "high" : adChange < -0.05 ? "medium" : "info",
			evidence: `ad sales ${cur}${fmtNum(b.adSalesPerDay)} → ${cur}${fmtNum(r.adSalesPerDay)} /day (${
				fmtPct(adChange)
			}); ad spend ${cur}${fmtNum(b.spend / Math.max(1, b.days))} → ${cur}${
				fmtNum(r.spend / Math.max(1, r.days))
			} /day (${fmtPct(relChange(b.spend / Math.max(1, b.days), r.spend / Math.max(1, r.days)))})`,
		});
	}
	if (orgChange != null) {
		signals.push({
			key: "organic-channel",
			label: "Organic (non-ad) sales",
			severity: orgChange < -0.15 ? "high" : orgChange < -0.05 ? "medium" : "info",
			evidence: `organic sales ${cur}${fmtNum(b.organicSalesPerDay)} → ${cur}${
				fmtNum(r.organicSalesPerDay)
			} /day (${fmtPct(orgChange)})`,
		});
	}
	// Which channel accounts for more of the absolute fall?
	if (adDrop < 0 || orgDrop < 0) {
		const driver = Math.abs(adDrop) >= Math.abs(orgDrop) ? "ad-attributed" : "organic";
		signals.push({
			key: Math.abs(adDrop) >= Math.abs(orgDrop) ? "ad-channel" : "organic-channel",
			label: "Channel driving the fall",
			severity: "info",
			evidence: `${driver} sales account for the larger share of the absolute fall (ad Δ ${cur}${
				fmtNum(adDrop)
			}/day vs organic Δ ${cur}${fmtNum(orgDrop)}/day)`,
		});
	}

	// Ad efficiency — CR / CPC moves that erode ad sales independent of spend.
	const crChange = relChange(b.adCr, r.adCr);
	const cpcChange = relChange(b.cpc, r.cpc);
	if (crChange != null && crChange < -0.1) {
		signals.push({
			key: "ad-efficiency",
			label: "Ad conversion rate",
			severity: crChange < -0.25 ? "high" : "medium",
			evidence: `ad CR ${fmtLevelPct(b.adCr)} → ${fmtLevelPct(r.adCr)} (${fmtPct(crChange)})`,
		});
	}
	if (cpcChange != null && cpcChange > 0.15) {
		signals.push({
			key: "ad-efficiency",
			label: "Cost per click",
			severity: cpcChange > 0.3 ? "high" : "medium",
			evidence: `CPC ${cur}${fmtMoney(b.cpc)} → ${cur}${fmtMoney(r.cpc)} (${fmtPct(cpcChange)})`,
		});
	}
	return signals;
}

/**
 * Minimal `ResolvedStore` list for the in-scope diagnoses. `loadLowInventory`
 * keys off `merchantId` + `marketplaceId`; the rest are filled for type-fit.
 */
function resolvedStoresFor(diagnoses: StoreDiagnosis[]): ResolvedStore[] {
	const seen = new Set<string>();
	const stores: ResolvedStore[] = [];
	for (const d of diagnoses) {
		const info = countryCodeToMarketplaceInfo[d.site.toUpperCase()];
		if (!info) continue;
		const key = `${d.merchantId}\x00${info.marketplaceId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		stores.push({
			merchantId: d.merchantId,
			merchantName: d.merchantId,
			marketplaceId: info.marketplaceId,
			countryCode: info.countryCode,
			currency: info.defaultCurrencyCode,
			storeName: `Amazon.${info.domainName.replace("www.amazon.", "")}`,
		});
	}
	return stores;
}

/** Attach low-runway flags + an "inventory" signal to each diagnosis (mutates). */
function attachInventory(diagnoses: StoreDiagnosis[], rows: LowInventoryRow[], runwayMax: number): void {
	for (const d of diagnoses) {
		const flags: InventoryFlag[] = rows
			.filter((r) => r.merchantId === d.merchantId && r.country.toUpperCase() === d.site.toUpperCase())
			.filter((r) => r.runway != null && r.runway <= runwayMax)
			.sort((a, b) => (a.runway ?? 9999) - (b.runway ?? 9999))
			.map((r) => ({
				asin: r.asin,
				label: r.label,
				family: r.family,
				runway: r.runway,
				runwayWithInbound: r.runwayWithInbound,
				inventoryAvailable: r.inventoryFba + r.inventoryFbm,
				inbound: r.inbound,
			}));
		d.inventoryFlags = flags;
		if (flags.length > 0) {
			const worst = flags[0]!;
			d.signals.push({
				key: "inventory",
				label: "Inventory runway",
				severity: (worst.runway ?? 99) <= 7 ? "high" : "medium",
				evidence: `${flags.length} ASIN(s) under ${runwayMax}d runway; lowest ${worst.label} (${worst.asin}) at ${
					worst.runway ?? "n/a"
				}d — low stock can suppress both traffic and conversion`,
			});
		}
	}
}

export function load(config: LoadConfig, sql: Sql): Effect.Effect<StoreDiagnosis[]> {
	return Effect.gen(function* () {
		const lookback = config.recentDays + config.baselineDays;

		const merchantIds = yield* Effect.promise(() => discoverMerchantIds(sql));
		const configured = yield* Effect.promise(() => discoverConfiguredCountries(sql));

		const since = sinceDaysAgo(lookback + 5);
		const stores = yield* Effect.promise(() => loadStoreSeries(sql, merchantIds, since));

		const out: StoreDiagnosis[] = [];
		for (const sd of stores) {
			if (
				!storeInScope(sd.merchantId, sd.site, {
					stores: config.stores,
					configured,
					all: config.allStores,
				})
			) continue;

			// Anchor the analysis to the latest day Sales & Traffic has reported
			// (when it's recent enough), so every window is a FULL recentDays /
			// baselineDays span that is also session-covered. Sales & Traffic lags
			// the fresh ALL_ORDERS tail by a day or two; analysing through that
			// horizon keeps whole 7-day weeks — day-of-week cycles dominate, so a
			// short final week would distort traffic vs a 4-week baseline — and a
			// self-consistent, exact traffic/conversion/price split. With no (or
			// badly stale) sessions, fall back to the freshest days, price-only.
			const lastSessionIdx = sd.days.map((d) => d.hasSessions).lastIndexOf(true);
			const useSessions = lastSessionIdx >= 0 &&
				(sd.days.length - 1 - lastSessionIdx) <= config.recentDays;
			const series = useSessions ? sd.days.slice(0, lastSessionIdx + 1) : sd.days;

			const window = series.slice(-lookback);
			if (window.length < config.recentDays + 1) continue; // not enough history

			const recentDaysArr = window.slice(window.length - config.recentDays);
			const baselineDaysArr = window.slice(0, window.length - config.recentDays);
			if (baselineDaysArr.length === 0) continue;

			const recent = aggregate(recentDaysArr);
			const baseline = aggregate(baselineDaysArr);
			if (recent.sales === 0 && baseline.sales === 0) continue;

			const deltaPct = baseline.salesPerDay > 0
				? (recent.salesPerDay - baseline.salesPerDay) / baseline.salesPerDay
				: null;
			const totalLogChange = logDelta(baseline.salesPerDay, recent.salesPerDay);

			// A trustworthy split needs session coverage over at least half of each
			// window; otherwise fall back to a price-only decomposition.
			const covered = (w: WindowAgg) => w.sessions > 0 && w.sessionDays >= Math.ceil(w.days / 2);
			const sessionsKnown = useSessions && covered(baseline) && covered(recent);
			const notes: string[] = [];
			if (!sessionsKnown) {
				notes.push(
					"Sessions data unavailable for one or both windows — traffic and conversion could not be separated; the price factor still holds.",
				);
			}

			const causes = buildCauses(baseline, recent, totalLogChange, sessionsKnown);
			const signals = buildSignals(baseline, recent, sd.currency);

			out.push({
				store: sd.label,
				merchantId: sd.merchantId,
				site: sd.site,
				currency: sd.currency,
				asOf: sd.asOf,
				baselineWindow: baseline,
				recentWindow: recent,
				deltaPct,
				totalLogChange,
				isDrop: deltaPct != null && deltaPct <= -config.dropThreshold,
				causes,
				signals,
				inventoryFlags: [],
				notes,
			});
		}

		// Inventory signal — flag low-runway ASINs that may be capping sales.
		// Best-effort: a missing inventory table degrades to no flags, never sinks
		// the whole diagnosis.
		if (!config.skipInventory && out.length > 0) {
			const invRows = yield* Effect.promise(() => loadLowInventory(sql, resolvedStoresFor(out), 7)).pipe(
				Effect.catchAllCause(() => Effect.succeed([] as LowInventoryRow[])),
			);
			attachInventory(out, invRows, config.inventoryRunwayMax);
		}

		// Biggest drops first, then by store label.
		out.sort((a, b) => (a.deltaPct ?? 0) - (b.deltaPct ?? 0));
		return out;
	});
}
