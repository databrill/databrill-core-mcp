/**
 * Which Sponsored Brands rows of the two Amazon Ads report tables count.
 *
 * Both `amzadapi_reports_v1__search_asin_placement__byDay` and
 * `amzadapi_reports_v1__product01__byDay` can hold a Sponsored Brands metric in two
 * forms per report key: an aggregate row with `advertisedProductId = ''`, and
 * per-ASIN rows that name the advertised ASIN. A key can have both, the per-ASIN
 * rows alone, or the aggregate row alone. Both forms can carry the same figures,
 * so summing every row counts such a key twice; keeping only one form loses the
 * key that has only the other.
 *
 * The rule, per key: the per-ASIN rows when there are any, else the aggregate row.
 * It keeps the ASIN wherever the report names one. Ported from the services
 * finance ledger, which applies it to the same SAP rows
 * (`services/libs/amazon/src/financeLedger/projectLedgerAdDays.ts`,
 * `calcSponsoredBrandsRowsCounted`), so the two agree on every Sponsored Brands
 * cost. It is the same at every grain: a store total and the sum of its ASIN
 * rows count the same rows. An aggregate row that counts names no ASIN; a reader
 * at ASIN grain gives it the first creative ASIN of its ad.
 *
 * A row counts unless it is a Sponsored Brands aggregate row whose key also has a
 * per-ASIN row. The functions here build that per-ASIN twin lookup as a
 * correlated subquery; each reader writes the rest of the predicate with its own
 * expression builder, so the outer `adProduct` and `advertisedProductId` stay
 * checked against `DB`:
 *
 *     .where((eb) =>
 *         eb.not(eb.and([
 *             eb("r.adProduct", "=", SPONSORED_BRANDS),
 *             eb("r.advertisedProductId", "=", ""),
 *             eb.exists(kyselySbAggregateHasPerAsinTwin_SAP(db, "r")),
 *         ]))
 *     )
 *
 * Postgres evaluates the subquery only for the Sponsored Brands aggregate rows the
 * query reads. On the SAP table the planner probes an index once per such row;
 * on the smaller product01 table it may instead hash that table's per-ASIN rows
 * once.
 */

import type { createCanonicalQueryBuilder } from "@jsr/databrill__core-pg-kysely/canonical";
import { sql } from "kysely";

type CanonicalDb = ReturnType<typeof createCanonicalQueryBuilder>;

/** The `adProduct` of Sponsored Brands rows, as both report tables spell it. */
export const SPONSORED_BRANDS = "Sponsored Brands";

/**
 * The SAP report's primary key without `advertisedProductId`: `date` and these
 * text columns. The date is matched on its own because its reference has its own
 * type.
 */
const SAP_KEY_TEXT_COLUMNS = [
	"merchantId",
	"marketplaceId",
	"adProduct",
	"campaignId",
	"adGroupId",
	"adId",
	"targetMatchType",
	"target",
	"searchTerm",
	"placementClassification",
] as const;

/**
 * The product01 report's primary key without `advertisedProductId` and
 * `advertisedProductSku`, which an aggregate row leaves empty together: `date`
 * and these text columns.
 */
const PRODUCT01_KEY_TEXT_COLUMNS = [
	"merchantId",
	"marketplaceId",
	"adProduct",
	"campaignId",
	"adGroupId",
	"adId",
	"convertedProductId",
	"convertedProductMarketplace",
	"productRelevance",
] as const;

/**
 * Whether an SB aggregate row of the SAP report has a per-ASIN twin, for
 * `eb.exists`: the per-ASIN rows that share the outer row's key, `SELECT 1 FROM
 * … AS twin WHERE twin.<key> = <outer>.<key> … AND twin."advertisedProductId" <> ''`.
 * It does not test the outer row itself: the caller restricts that to Sponsored
 * Brands aggregate rows, the only rows that can have a twin.
 *
 * @param db - The canonical query builder of the outer query
 * @param outer - The outer query's alias of the SAP table
 * @returns The subquery, for `eb.exists`
 *
 * @example
 * eb.exists(kyselySbAggregateHasPerAsinTwin_SAP(db, "r"))
 */
export function kyselySbAggregateHasPerAsinTwin_SAP(db: CanonicalDb, outer: string) {
	let twin = db
		.selectFrom("amzadapi_reports_v1__search_asin_placement__byDay as twin")
		.select(sql<number>`1`.as("one"))
		.where("twin.advertisedProductId", "<>", "")
		.where("twin.date", "=", sql.ref<Temporal.PlainDate>(`${outer}.date`));
	for (const column of SAP_KEY_TEXT_COLUMNS) {
		twin = twin.where(`twin.${column}`, "=", sql.ref<string>(`${outer}.${column}`));
	}
	return twin;
}

/**
 * Whether an SB aggregate row of the product01 report has a per-ASIN twin;
 * {@link kyselySbAggregateHasPerAsinTwin_SAP} for product01.
 *
 * @param db - The canonical query builder of the outer query
 * @param outer - The outer query's alias of the product01 table
 * @returns The subquery, for `eb.exists`
 *
 * @example
 * eb.exists(kyselySbAggregateHasPerAsinTwin_Product01(db, "r"))
 */
export function kyselySbAggregateHasPerAsinTwin_Product01(db: CanonicalDb, outer: string) {
	let twin = db
		.selectFrom("amzadapi_reports_v1__product01__byDay as twin")
		.select(sql<number>`1`.as("one"))
		.where("twin.advertisedProductId", "<>", "")
		.where("twin.date", "=", sql.ref<Temporal.PlainDate>(`${outer}.date`));
	for (const column of PRODUCT01_KEY_TEXT_COLUMNS) {
		twin = twin.where(`twin.${column}`, "=", sql.ref<string>(`${outer}.${column}`));
	}
	return twin;
}
