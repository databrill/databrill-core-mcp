/**
 * loadTraffic — per-ASIN (or family) Sales & Traffic metrics over a window.
 *
 * Store and product inputs continue to use loadAds's established resolution
 * helpers. Metric queries are compiled by the canonical
 * `AmazonReport_SALES_AND_TRAFFIC` reader, once per marketplace so its ASIN and
 * FAMILY levels do not merge marketplace rows that this public result retains.
 */

import {
	type AmazonReportSalesAndTrafficResult,
	type AmazonReportSalesAndTrafficRow,
	type CanonicalLevel,
	type CanonicalWindow,
	createCanonicalQueryBuilder,
	readAmazonReportSalesAndTraffic,
} from "@jsr/databrill__core-pg-kysely/canonical";
import type postgres from "postgres";
import {
	type DateRange,
	parseWhenRange,
	type ResolvedStore,
	resolveProducts,
	resolveStores,
	resolveTrailingRange,
} from "../loadAds/loadAds.ts";
import {
	type LoadTrafficParams,
	type LoadTrafficResult,
	type TrafficGroupBy,
	type TrafficRow,
	type TrafficTimeUnit,
	VALID_TRAFFIC_GROUP_BY,
	VALID_TRAFFIC_TIME_UNITS,
} from "./types.ts";

/** The only canonical measures exposed through loadTraffic's established result. */
export const LOAD_TRAFFIC_CANONICAL_MEASURES = [
	"sessions",
	"unitsOrdered",
	"orderedProductSales",
	"unitSessionPercentage",
] as const;

interface MarketplaceGroup {
	readonly marketplaceId: string;
	readonly countryCode: string;
	readonly stores: { readonly merchantId: string; readonly marketplaceId: string }[];
	readonly merchantIds: Set<string>;
}

function fail(msg: string): never {
	throw new Error(msg);
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function isTrafficGroupBy(value: string): value is TrafficGroupBy {
	return VALID_TRAFFIC_GROUP_BY.some((candidate) => candidate === value);
}

function isTrafficTimeUnit(value: string): value is TrafficTimeUnit {
	return VALID_TRAFFIC_TIME_UNITS.some((candidate) => candidate === value);
}

function parseTrafficGroupBy(value: string): TrafficGroupBy {
	if (isTrafficGroupBy(value)) {
		return value;
	}
	return fail(`Unknown groupBy '${value}'. Valid: ${VALID_TRAFFIC_GROUP_BY.join(", ")}`);
}

function parseTrafficTimeUnit(value: string): TrafficTimeUnit {
	if (isTrafficTimeUnit(value)) {
		return value;
	}
	return fail(`Unknown timeUnit '${value}'. Valid: ${VALID_TRAFFIC_TIME_UNITS.join(", ")}`);
}

function groupStoresByMarketplace(stores: readonly ResolvedStore[]): MarketplaceGroup[] {
	const groups = new Map<string, MarketplaceGroup>();
	for (const store of stores) {
		let group = groups.get(store.marketplaceId);
		if (group === undefined) {
			group = {
				marketplaceId: store.marketplaceId,
				countryCode: store.countryCode,
				stores: [],
				merchantIds: new Set<string>(),
			};
			groups.set(store.marketplaceId, group);
		}
		if (!group.merchantIds.has(store.merchantId)) {
			group.merchantIds.add(store.merchantId);
			group.stores.push({ merchantId: store.merchantId, marketplaceId: store.marketplaceId });
		}
	}
	return [...groups.values()];
}

function resultError(result: AmazonReportSalesAndTrafficResult): string {
	const reasons = result.unavailable.map((entry) => entry.reason);
	return reasons.length === 0 ? "No definitive Sales and Traffic date was found" : reasons.join(" ");
}

function numberMeasure(row: AmazonReportSalesAndTrafficRow, name: string): number {
	return row.measures[name] ?? 0;
}

function mapTrafficRow(
	row: AmazonReportSalesAndTrafficRow,
	group: MarketplaceGroup,
	groupBy: TrafficGroupBy,
): TrafficRow {
	const sessions = numberMeasure(row, "sessions");
	const units = numberMeasure(row, "unitsOrdered");
	const out: TrafficRow = {
		country: group.countryCode,
		marketplaceId: group.marketplaceId,
		period: row.period,
		sessions: round2(sessions),
		units: round2(units),
		sales: round2(numberMeasure(row, "orderedProductSales")),
		cr: round2(numberMeasure(row, "unitSessionPercentage")),
	};
	if (groupBy === "family") {
		out.family = row.key["family"] ?? "(unmapped)";
	} else {
		out.asin = row.key["asin"] ?? "";
	}
	return out;
}

function compareTrafficRows(left: TrafficRow, right: TrafficRow, groupBy: TrafficGroupBy): number {
	const period = left.period.localeCompare(right.period);
	if (period !== 0) {
		return period;
	}
	const leftGroup = groupBy === "family" ? left.family ?? "" : left.asin ?? "";
	const rightGroup = groupBy === "family" ? right.family ?? "" : right.asin ?? "";
	const grouped = leftGroup.localeCompare(rightGroup);
	return grouped !== 0 ? grouped : left.marketplaceId.localeCompare(right.marketplaceId);
}

export async function loadTraffic(params: LoadTrafficParams, sql: postgres.Sql): Promise<LoadTrafficResult> {
	if (!params.stores) fail("stores is required");
	if (!params.when) fail("when is required");

	const groupBy = parseTrafficGroupBy(params.groupBy ?? "asin");
	const timeUnit = parseTrafficTimeUnit(params.timeUnit ? params.timeUnit.toUpperCase() : "WEEK");

	const stores = await resolveStores(params.stores, sql);
	const marketplaceGroups = groupStoresByMarketplace(stores);
	const when = parseWhenRange(params.when);

	let productAsins: string[] | null = null;
	if (params.products) {
		productAsins = await resolveProducts(params.products, sql);
		if (productAsins.length === 0) fail("products resolved to zero ASINs");
	}

	const db = createCanonicalQueryBuilder();
	const level: CanonicalLevel = groupBy === "family" ? "FAMILY" : "ASIN";
	function readGroup(
		group: MarketplaceGroup,
		window: CanonicalWindow,
		measures: readonly string[],
	): Promise<AmazonReportSalesAndTrafficResult> {
		return readAmazonReportSalesAndTraffic(db, sql, {
			level,
			timeGranularity: timeUnit,
			window,
			stores: group.stores,
			asins: productAsins ?? undefined,
			measures,
		});
	}

	let range: DateRange;
	if (when.kind === "explicit") {
		range = when.range;
	} else {
		const probes = await Promise.all(
			marketplaceGroups.map((group) => readGroup(group, { kind: "trailingDays", days: 1 }, ["sessions"])),
		);
		let earliestDate: string | null = null;
		for (let index = 0; index < probes.length; index++) {
			const probe = probes[index];
			const group = marketplaceGroups[index];
			if (probe === undefined || group === undefined) {
				fail("Internal loadTraffic marketplace probe mismatch");
			}
			if (probe.window === null) {
				fail(`${group.countryCode}: ${resultError(probe)}`);
			}
			if (earliestDate === null || probe.window.dateLast < earliestDate) {
				earliestDate = probe.window.dateLast;
			}
		}
		if (earliestDate === null) {
			fail("No Sales and Traffic marketplaces were resolved");
		}
		range = resolveTrailingRange(when.duration, earliestDate);
	}

	const canonicalResults = await Promise.all(
		marketplaceGroups.map((group) =>
			readGroup(
				group,
				{ kind: "explicit", dateFirst: range.dateFirst, dateLast: range.dateLast },
				LOAD_TRAFFIC_CANONICAL_MEASURES,
			)
		),
	);
	const data: TrafficRow[] = [];
	for (let index = 0; index < canonicalResults.length; index++) {
		const result = canonicalResults[index];
		const group = marketplaceGroups[index];
		if (result === undefined || group === undefined) {
			fail("Internal loadTraffic marketplace result mismatch");
		}
		if (when.kind === "trailing" && result.window === null) {
			fail(`${group.countryCode}: ${resultError(result)}`);
		}
		for (const row of result.rows) {
			data.push(mapTrafficRow(row, group, groupBy));
		}
	}
	data.sort((left, right) => compareTrafficRows(left, right, groupBy));

	return {
		meta: {
			dateFirst: range.dateFirst,
			dateLast: range.dateLast,
			stores: [...new Set(stores.map((store) => store.countryCode))],
			rowCount: data.length,
			groupBy,
			timeUnit,
		},
		data,
	};
}
