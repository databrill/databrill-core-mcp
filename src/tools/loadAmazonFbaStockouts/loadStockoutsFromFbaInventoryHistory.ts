/**
 * Stockout episodes of one store from `amzfact_fnsku_fbaInventory_history`.
 *
 * The table is sparse: a row exists only on a day the FNSKU's `_latest` state changed, and its `…First`,
 * `…Min` and `…Max` cover only the changes recorded that day. The reader rule in the table's spec gives the
 * whole day from the previous row of the same FNSKU, whatever its date: the value carried into the day is
 * the previous row's `…Last`, the day's low `LEAST(Min, previous Last)` and its high
 * `GREATEST(Max, previous Last)`. NULL quantities are not reported and read as 0.
 *
 * One statement per store. The rows of `dateFirst`..`dateLast` come from one range read through the
 * `(merchantId, marketplaceId, date)` index. Only for the FNSKUs that have rows there, one backward
 * primary-key probe fetches the last row before `dateFirst`: the previous row of the first day in range,
 * and the state at the window edge. The probes run only when the store has a history row before
 * `dateFirst`; otherwise none could find a row. Nothing reads further back, and `_latest` is not read, so an FNSKU
 * whose inventory did not change in the range has no row and no episode.
 *
 * The window edge: when the last row before `dateFirst` closed at zero, the FNSKU was already out from that
 * day at the latest. Its episode has no `stockoutDate`; `outOnOrBefore` is that row's date.
 */
import type { createCanonicalQueryBuilder } from "@jsr/databrill__core-pg-kysely/canonical";
import { Effect } from "effect";
import { sql as ksql } from "kysely";
import type { Sql } from "postgres";
import { runCompiled } from "../../runCompiled.ts";
import type { AmazonFbaStockoutEpisodeDraft } from "./types.ts";

type CanonicalDb = ReturnType<typeof createCanonicalQueryBuilder>;

type HistoryRowKind = "STOCKOUT" | "OUT_AT_DATE_FIRST" | "OUT_ON_FIRST_ROW" | "FIRST_ROW_IN_STOCK" | "DIP";

interface HistoryEpisodeRow {
	readonly fnsku: string;
	readonly date: string;
	readonly edgeDate: string | null;
	readonly nextInStockDate: string | null;
	readonly close: number;
	readonly supplyHigh: number;
	readonly groupSupplyMax: number | null;
	readonly edgeSupply: number | null;
	readonly rowKind: HistoryRowKind;
}

/** An FNSKU whose first history row ever is in range and closed in stock. */
export interface AmazonFbaStockoutFirstHistoryRowInStock {
	readonly fnsku: string;
	readonly date: string;
}

/**
 * Read the stockout episodes of one store's history rows in `dateFirst`..`dateLast`.
 *
 * `fnskus` restricts the read to those FNSKUs; null reads every FNSKU with rows in range. When
 * `historyStartsBeforeDateFirst` is false, an FNSKU whose first row is in range and closed at zero yields a
 * draft with `isOutOnFirstHistoryRow`, and one whose first row closed in stock is returned in
 * `firstRowsInStock`, both for the merge with the ledger in `load.ts`.
 */
export function loadStockoutsFromFbaInventoryHistory(input: {
	readonly sql: Sql;
	readonly db: CanonicalDb;
	readonly merchantId: string;
	readonly marketplaceId: string;
	readonly dateFirst: string;
	readonly dateLast: string;
	readonly historyStartsBeforeDateFirst: boolean;
	readonly fnskus: readonly string[] | null;
}): Effect.Effect<
	{
		readonly drafts: readonly AmazonFbaStockoutEpisodeDraft[];
		readonly firstRowsInStock: readonly AmazonFbaStockoutFirstHistoryRowInStock[];
	},
	Error
> {
	return Effect.gen(function* () {
		const { merchantId, marketplaceId, dateFirst, dateLast } = input;
		const fnskuFilter = input.fnskus === null
			? ksql``
			: ksql`AND h."fnsku" = ANY(${ksql.val(input.fnskus)}::text[])`;
		// No history before dateFirst means no edge row: the probes are left out, the edge an empty relation.
		const edgeBlock = input.historyStartsBeforeDateFirst
			? ksql`
  SELECT f."fnsku", p."date" AS "edgeDate",
         COALESCE(p."fulfillableLast", 0) AS "edgeClose",
         COALESCE(p."futureSupplyBuyableLast", 0) AS "edgeSupply"
  FROM (SELECT DISTINCT r."fnsku" FROM "inRange" AS r) AS f
  CROSS JOIN LATERAL (
    SELECT p."date", p."fulfillableLast", p."futureSupplyBuyableLast"
    FROM "amzfact_fnsku_fbaInventory_history" AS p
    WHERE p."merchantId" = ${merchantId} AND p."marketplaceId" = ${marketplaceId}
      AND p."fnsku" = f."fnsku" AND p."date" < ${dateFirst}::date
    ORDER BY p."date" DESC
    LIMIT 1
  ) AS p`
			: ksql`
  SELECT NULL::text AS "fnsku", NULL::date AS "edgeDate", NULL::integer AS "edgeClose",
         NULL::integer AS "edgeSupply"
  WHERE FALSE`;
		const rows = yield* runCompiled(input.sql, () =>
			ksql<HistoryEpisodeRow>`
WITH "inRange" AS (
  SELECT h."fnsku", h."date", h."fulfillableMin", h."fulfillableLast",
         h."futureSupplyBuyableMax", h."futureSupplyBuyableLast"
  FROM "amzfact_fnsku_fbaInventory_history" AS h
  WHERE h."merchantId" = ${merchantId} AND h."marketplaceId" = ${marketplaceId}
    AND h."date" >= ${dateFirst}::date AND h."date" <= ${dateLast}::date
    ${fnskuFilter}
),
"edge" AS (${edgeBlock}
),
"days" AS (
  SELECT r."fnsku", r."date", e."edgeDate", e."edgeSupply",
         COALESCE(r."fulfillableLast", 0) AS "close",
         COALESCE(r."fulfillableMin", 0) AS "low",
         COALESCE(lag(COALESCE(r."fulfillableLast", 0)) OVER w, e."edgeClose") AS "prevClose",
         GREATEST(COALESCE(r."futureSupplyBuyableMax", 0),
                  COALESCE(lag(COALESCE(r."futureSupplyBuyableLast", 0)) OVER w, e."edgeSupply")) AS "supplyHigh",
         row_number() OVER w AS "rowNo",
         count(*) FILTER (WHERE COALESCE(r."fulfillableLast", 0) > 0) OVER w AS "grp",
         min(r."date") FILTER (WHERE COALESCE(r."fulfillableLast", 0) > 0)
           OVER (PARTITION BY r."fnsku" ORDER BY r."date"
                 ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS "nextInStockDate"
  FROM "inRange" AS r
  LEFT JOIN "edge" AS e ON e."fnsku" = r."fnsku"
  WINDOW w AS (PARTITION BY r."fnsku" ORDER BY r."date")
),
"grouped" AS (
  SELECT d.*,
         max(d."supplyHigh") FILTER (WHERE d."close" = 0)
           OVER (PARTITION BY d."fnsku", d."grp") AS "groupSupplyMax"
  FROM "days" AS d
),
"flagged" AS (
  SELECT g.*,
         CASE
           WHEN g."close" = 0 AND g."prevClose" > 0 THEN 'STOCKOUT'
           WHEN g."rowNo" = 1 AND g."edgeDate" IS NOT NULL AND g."prevClose" = 0 THEN 'OUT_AT_DATE_FIRST'
           WHEN g."rowNo" = 1 AND g."edgeDate" IS NULL AND g."close" = 0 THEN 'OUT_ON_FIRST_ROW'
           WHEN g."rowNo" = 1 AND g."edgeDate" IS NULL AND g."close" > 0 THEN 'FIRST_ROW_IN_STOCK'
           WHEN g."close" > 0 AND g."prevClose" > 0 AND g."low" = 0 THEN 'DIP'
         END AS "rowKind"
  FROM "grouped" AS g
)
SELECT f."fnsku", f."date"::text AS "date", f."edgeDate"::text AS "edgeDate",
       f."nextInStockDate"::text AS "nextInStockDate", f."close", f."supplyHigh", f."groupSupplyMax",
       f."edgeSupply", f."rowKind"
FROM "flagged" AS f
WHERE f."rowKind" IS NOT NULL
ORDER BY f."fnsku", f."date"
`.compile(input.db));

		const drafts: AmazonFbaStockoutEpisodeDraft[] = [];
		const firstRowsInStock: AmazonFbaStockoutFirstHistoryRowInStock[] = [];
		const base = {
			merchantId,
			marketplaceId,
			isOutOnFirstHistoryRow: false,
			isOpenAtLedgerEnd: false,
		} as const;
		for (const row of rows) {
			switch (row.rowKind) {
				case "STOCKOUT": {
					drafts.push({
						...base,
						fnsku: row.fnsku,
						episodeType: "CLOSED_OUT",
						stockoutDate: row.date,
						stockoutBasis: "FULFILLABLE",
						outOnOrBefore: null,
						backInStockDate: row.nextInStockDate,
						backInStockBasis: row.nextInStockDate === null ? null : "FULFILLABLE",
						futureSupplyBuyableMax: row.groupSupplyMax,
					});
					break;
				}
				case "OUT_AT_DATE_FIRST": {
					const recoversOnFirstRow = row.close > 0;
					const backInStockDate = recoversOnFirstRow ? row.date : row.nextInStockDate;
					drafts.push({
						...base,
						fnsku: row.fnsku,
						episodeType: "CLOSED_OUT",
						stockoutDate: null,
						stockoutBasis: null,
						outOnOrBefore: row.edgeDate,
						backInStockDate,
						backInStockBasis: backInStockDate === null ? null : "FULFILLABLE",
						futureSupplyBuyableMax: recoversOnFirstRow
							? row.edgeSupply
							: Math.max(row.groupSupplyMax ?? 0, row.edgeSupply ?? 0),
					});
					break;
				}
				case "OUT_ON_FIRST_ROW": {
					if (input.historyStartsBeforeDateFirst) {
						// A first row ever after history began is a product that appeared later.
						break;
					}
					drafts.push({
						...base,
						fnsku: row.fnsku,
						episodeType: "CLOSED_OUT",
						stockoutDate: null,
						stockoutBasis: null,
						outOnOrBefore: row.date,
						backInStockDate: row.nextInStockDate,
						backInStockBasis: row.nextInStockDate === null ? null : "FULFILLABLE",
						futureSupplyBuyableMax: row.groupSupplyMax,
						isOutOnFirstHistoryRow: true,
					});
					break;
				}
				case "FIRST_ROW_IN_STOCK": {
					if (!input.historyStartsBeforeDateFirst) {
						firstRowsInStock.push({ fnsku: row.fnsku, date: row.date });
					}
					break;
				}
				case "DIP": {
					drafts.push({
						...base,
						fnsku: row.fnsku,
						episodeType: "INTRADAY_DIP",
						stockoutDate: row.date,
						stockoutBasis: "FULFILLABLE",
						outOnOrBefore: null,
						backInStockDate: row.date,
						backInStockBasis: "FULFILLABLE",
						futureSupplyBuyableMax: row.supplyHigh,
					});
					break;
				}
			}
		}
		return { drafts, firstRowsInStock };
	});
}
