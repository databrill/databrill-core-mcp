/**
 * Stockout episodes of one merchant's stores from the FBA inventory ledger, for the days of the range before
 * each store's FBA inventory history starts.
 *
 * What it reads. `amzfact_fnsku_ledger_history` holds the DAILY/FC summary: one row per fulfillment center,
 * FNSKU, disposition and day, listing every key with a nonzero balance or a movement, so a key absent on a
 * day sat at zero, and a day with no row at all for the merchant is a summary report Amazon returned empty.
 * The ledger is read up to the merchant's newest summary day and no further: the provisional estimate after
 * it is not read. `amazon_fulfillment_center` gives each center's country. Only the SELLABLE disposition
 * counts.
 *
 * The criterion. An episode is a run of recorded days on which no center of the store's center countries
 * holds a SELLABLE ending balance above zero, after a day on which one did. A day with no summary report is
 * not recorded, never out, and an episode whose days on both sides of it are out spans it.
 *
 * A lower bound. Units reserved for orders, transfers or center processing count in the ledger balance, so
 * a stockout with reserved units is not visible here, and no episode does not mean in stock.
 *
 * Which keys are read. Rows in range drive every read: the merchant's summary rows of the range through the
 * `(merchantId, date)` index, and only for the keys among them, one backward primary-key probe for the
 * key's last row before the range. The range read keeps only the centers of the inventory pools the stores
 * count, each inventory pool up to the last day one of its stores needs, and an inventory pool where the
 * merchant has no center with ledger rows is not read at all; the merchant's centers come from one primary-key
 * probe per center. `amzfact_fnsku_ledger_latest` lists every key the merchant ever had, dormant ones
 * included, so enumerating keys from it would cost one probe per key whatever the range holds.
 * Consequences: a ledger FNSKU with no SELLABLE row in its range has no episode and is not read, and the
 * exact first day of an episode already out at `dateFirst` is not available, since the centers that emptied
 * last have no rows in range. Such an episode has no `stockoutDate`; `outOnOrBefore` is the merchant's last
 * recorded ledger day before `dateFirst`, on which the probes show the FNSKU out.
 *
 * A first receipt is not a return to stock. An episode already out at `dateFirst` needs a ledger row of the
 * FNSKU in the inventory pool before `dateFirst`: the same backward probe's row, whatever its date.
 *
 * Inventory pools. An inventory pool is the set of centers whose stock serves a marketplace; it is not
 * Amazon's selling-partner region (NA, EU, FE), and one merchant's ledger can hold centers of several
 * inventory pools. The countries of Amazon's Pan-European FBA program share one inventory, so a pan-European
 * marketplace counts the centers of every country in {@link PAN_EUROPEAN_FBA_COUNTRY_CODES}. GB, which left
 * the program on 2021-01-01, every North American country and every other marketplace count their own
 * country's centers. A center of the merchant's ledger with no country in `amazon_fulfillment_center`, or
 * missing from it, counts in no inventory pool. It is reported when it has rows on the days read, from
 * `dateFirst` to the latest inventory pool's last day; its rows are read in the same range read and go no
 * further than naming it.
 */
import type { createCanonicalQueryBuilder } from "@jsr/databrill__core-pg-kysely/canonical";
import { Effect } from "effect";
import { type RawBuilder, sql as ksql } from "kysely";
import { DateTime } from "luxon";
import type { Sql } from "postgres";
import { canonicalCountryCode } from "../../amazonConstants.ts";
import { makeCompositeKey } from "../../makeCompositeKey.ts";
import { runCompiled } from "../../runCompiled.ts";
import type { AmazonFbaStockoutEpisodeDraft } from "./types.ts";

type CanonicalDb = ReturnType<typeof createCanonicalQueryBuilder>;

/**
 * The countries whose fulfillment centers hold one pooled inventory under Amazon's Pan-European FBA program,
 * from Amazon's seller pages on Pan-European FBA. GB left the program on 2021-01-01. CZ and SK are center
 * countries with no marketplace. The set errs towards inclusion: a center country wrongly included makes the
 * tool miss a stockout, which the ledger's lower bound already allows, while one wrongly left out would
 * invent stockouts. IE is not in it, so amazon.ie counts its own country's centers.
 */
export const PAN_EUROPEAN_FBA_COUNTRY_CODES = ["BE", "CZ", "DE", "ES", "FR", "IT", "NL", "PL", "SE", "SK"] as const;

const PAN_EUROPEAN_INVENTORY_POOL_KEY = "PAN_EUROPEAN";

function isPanEuropeanCountry(countryCode: string): boolean {
	return PAN_EUROPEAN_FBA_COUNTRY_CODES.some((code) => code === countryCode);
}

/** The countries whose centers count for a store in `countryCode`'s marketplace. */
export function calcLedgerCenterCountryCodes(countryCode: string): readonly string[] {
	const canonical = canonicalCountryCode(countryCode);
	return isPanEuropeanCountry(canonical) ? [...PAN_EUROPEAN_FBA_COUNTRY_CODES] : [canonical];
}

function calcInventoryPoolKey(countryCode: string): string {
	const canonical = canonicalCountryCode(countryCode);
	return isPanEuropeanCountry(canonical) ? PAN_EUROPEAN_INVENTORY_POOL_KEY : canonical;
}

/** The ISO date `days` days after `date` (before it when negative). */
export function addDaysToIsoDate(date: string, days: number): string {
	return DateTime.fromISO(date, { zone: "utc" }).plus({ days }).toISODate()!;
}

function listIsoDates(dateFirst: string, dateLast: string): string[] {
	const dates: string[] = [];
	for (let date = dateFirst; date <= dateLast; date = addDaysToIsoDate(date, 1)) {
		dates.push(date);
	}
	return dates;
}

/** A store's days read from the ledger: `dateFirst`..`ledgerDateLast`. */
export interface AmazonFbaLedgerStoreRange {
	readonly marketplaceId: string;
	readonly countryCode: string;
	readonly ledgerDateLast: string;
	/** The store's first history day in range; null when the store has no history up to `dateLast`. */
	readonly historyStartsAt: string | null;
}

/** What the ledger read says about one store. */
export interface AmazonFbaLedgerStoreMeta {
	readonly ledgerSummaryDateLast: string | null;
	readonly ledgerDaysWithoutReport: readonly string[];
}

interface LedgerEdgeRow {
	readonly newestSummaryDate: string | null;
	readonly lastSummaryDateBeforeDateFirst: string | null;
}

interface LedgerStatusRow {
	readonly rowKind: "RUN" | "SEEN" | "PRIOR" | "CENTER";
	readonly fnsku: string | null;
	readonly inventoryPoolKey: string | null;
	readonly fromPos: number | null;
	readonly toPos: number | null;
	readonly firstSeenDate: string | null;
	/** Set on CENTER rows: a center with no country that has rows on the days read. */
	readonly fulfillmentCenter: string | null;
}

interface LedgerCenterRow {
	readonly fulfillmentCenter: string;
	readonly inventoryPoolKey: string | null;
}

/** A center's inventory pool key in SQL, as `calcInventoryPoolKey` gives it; null for a center without a country. */
function inventoryPoolKeyOf(countryCode: RawBuilder<unknown>): RawBuilder<unknown> {
	return ksql`CASE WHEN ${countryCode} IS NULL THEN NULL
              WHEN ${countryCode} = ANY(${ksql.val([...PAN_EUROPEAN_FBA_COUNTRY_CODES])}::text[])
                THEN ${PAN_EUROPEAN_INVENTORY_POOL_KEY}::text
              ELSE ${countryCode} END`;
}

interface LedgerRun {
	readonly fromPos: number;
	readonly toPos: number;
}

interface LedgerEpisodeDates {
	readonly stockoutDate: string | null;
	readonly outOnOrBefore: string | null;
	readonly backInStockDate: string | null;
}

/**
 * Read one merchant's ledger stockout episodes for the stores in `stores`, all of whose ledger days start
 * on `dateFirst`. `fnskus` restricts the read to those FNSKUs; null reads every FNSKU with rows in range.
 * Drafts and store meta are keyed by marketplace id.
 */
export function loadStockoutsFromFbaLedger(input: {
	readonly sql: Sql;
	readonly db: CanonicalDb;
	readonly merchantId: string;
	readonly dateFirst: string;
	readonly stores: readonly AmazonFbaLedgerStoreRange[];
	readonly fnskus: readonly string[] | null;
}): Effect.Effect<
	{
		readonly draftsByStore: ReadonlyMap<string, readonly AmazonFbaStockoutEpisodeDraft[]>;
		readonly storeLedgerMeta: ReadonlyMap<string, AmazonFbaLedgerStoreMeta>;
		readonly centersWithoutCountry: readonly string[];
	},
	Error
> {
	return Effect.gen(function* () {
		const { merchantId, db, stores } = input;
		const draftsByStore = new Map<string, readonly AmazonFbaStockoutEpisodeDraft[]>();
		const storeLedgerMeta = new Map<string, AmazonFbaLedgerStoreMeta>();
		if (stores.length === 0) {
			return { draftsByStore, storeLedgerMeta, centersWithoutCountry: [] };
		}
		const ledgerDateFirst = input.dateFirst;
		const ledgerDateLast = stores.map((store) => store.ledgerDateLast).reduce((a, b) => (a > b ? a : b));

		// L1: the merchant's summary edges, two (merchantId, date) index probes.
		const edgeRows = yield* runCompiled(input.sql, () =>
			ksql<LedgerEdgeRow>`
SELECT
  (SELECT max(h."date") FROM "amzfact_fnsku_ledger_history" AS h
   WHERE h."merchantId" = ${merchantId})::text AS "newestSummaryDate",
  (SELECT max(h."date") FROM "amzfact_fnsku_ledger_history" AS h
   WHERE h."merchantId" = ${merchantId} AND h."date" < ${ledgerDateFirst}::date)::text AS "lastSummaryDateBeforeDateFirst"
`.compile(db));
		const newestSummaryDate = edgeRows[0]?.newestSummaryDate ?? null;
		if (newestSummaryDate === null) {
			for (const store of stores) {
				storeLedgerMeta.set(store.marketplaceId, { ledgerSummaryDateLast: null, ledgerDaysWithoutReport: [] });
			}
			return { draftsByStore, storeLedgerMeta, centersWithoutCountry: [] };
		}
		const lastSummaryDateBeforeDateFirst = edgeRows[0]?.lastSummaryDateBeforeDateFirst ?? null;
		const summaryDateLast = ledgerDateLast < newestSummaryDate ? ledgerDateLast : newestSummaryDate;
		const readsSummary = ledgerDateFirst <= summaryDateLast;

		// L2: the days with a summary report, one (merchantId, date) index probe per day.
		const reportedDays = readsSummary
			? (yield* runCompiled(input.sql, () =>
				ksql<{ readonly date: string }>`
SELECT d::date::text AS "date"
FROM generate_series(${ledgerDateFirst}::date::timestamp, ${summaryDateLast}::date::timestamp, interval '1 day') AS d
WHERE EXISTS (
  SELECT 1 FROM "amzfact_fnsku_ledger_history" AS h
  WHERE h."merchantId" = ${merchantId} AND h."date" = d::date
)
ORDER BY 1
`.compile(db))).map((row) => row.date)
			: [];
		const reportedDaySet = new Set(reportedDays);
		for (const store of stores) {
			const storeSummaryDateLast = store.ledgerDateLast < newestSummaryDate
				? store.ledgerDateLast
				: newestSummaryDate;
			storeLedgerMeta.set(store.marketplaceId, {
				ledgerSummaryDateLast: newestSummaryDate,
				ledgerDaysWithoutReport: ledgerDateFirst <= storeSummaryDateLast
					? listIsoDates(ledgerDateFirst, storeSummaryDateLast).filter((date) => !reportedDaySet.has(date))
					: [],
			});
		}

		if (reportedDays.length === 0) {
			return { draftsByStore, storeLedgerMeta, centersWithoutCountry: [] };
		}
		// The spine: the last summary day before the range, then its reported days; missing-report days are absent.
		const previousRecordedDay = lastSummaryDateBeforeDateFirst;
		const spine = [...(previousRecordedDay === null ? [] : [previousRecordedDay]), ...reportedDays];
		const hasPreviousRecordedDay = previousRecordedDay !== null;

		// L2b: the merchant's ledger centers, one primary-key probe per center, with each center's inventory pool.
		const centerRows = yield* runCompiled(input.sql, () =>
			ksql<LedgerCenterRow>`
WITH RECURSIVE "centers" AS (
  (SELECT h."fulfillmentCenter" FROM "amzfact_fnsku_ledger_history" AS h
   WHERE h."merchantId" = ${merchantId} ORDER BY h."fulfillmentCenter" LIMIT 1)
  UNION ALL
  SELECT n."fulfillmentCenter" FROM "centers" AS p
  CROSS JOIN LATERAL (
    SELECT h."fulfillmentCenter" FROM "amzfact_fnsku_ledger_history" AS h
    WHERE h."merchantId" = ${merchantId} AND h."fulfillmentCenter" > p."fulfillmentCenter"
    ORDER BY h."fulfillmentCenter" LIMIT 1
  ) AS n
)
SELECT k."fulfillmentCenter", ${inventoryPoolKeyOf(ksql.ref("c.countryCode"))} AS "inventoryPoolKey"
FROM "centers" AS k
LEFT JOIN "amazon_fulfillment_center" AS c ON c."fulfillmentCenter" = k."fulfillmentCenter"
ORDER BY 1
`.compile(db));
		const probedCentersWithoutCountry = centerRows.filter((row) => row.inventoryPoolKey === null).map((row) =>
			row.fulfillmentCenter
		);
		// Per inventory pool the stores count and the merchant has centers in: those centers, read up to its last day.
		const inventoryPoolReads: LedgerInventoryPoolRead[] = [];
		for (const inventoryPoolKey of new Set(stores.map((store) => calcInventoryPoolKey(store.countryCode)))) {
			const centers = centerRows.filter((row) => row.inventoryPoolKey === inventoryPoolKey).map((row) =>
				row.fulfillmentCenter
			);
			const inventoryPoolDateLast = stores
				.filter((store) => calcInventoryPoolKey(store.countryCode) === inventoryPoolKey)
				.map((store) => (store.ledgerDateLast < summaryDateLast ? store.ledgerDateLast : summaryDateLast))
				.reduce((a, b) => (a > b ? a : b));
			if (centers.length > 0) {
				inventoryPoolReads.push({ inventoryPoolKey, centers, dateLast: inventoryPoolDateLast });
			}
		}
		if (inventoryPoolReads.length === 0) {
			for (const store of stores) {
				draftsByStore.set(store.marketplaceId, []);
			}
			return { draftsByStore, storeLedgerMeta, centersWithoutCountry: [] };
		}
		const statusRows = yield* runCompiled(input.sql, () =>
			buildLedgerStatusQuery({
				merchantId,
				ledgerDateFirst,
				previousRecordedDay,
				spine,
				inventoryPoolReads,
				centersWithoutCountry: probedCentersWithoutCountry,
				fnskus: input.fnskus,
			}).compile(db));
		const centersWithoutCountry = statusRows.flatMap((row) =>
			row.rowKind === "CENTER" && row.fulfillmentCenter !== null ? [row.fulfillmentCenter] : []
		).sort();

		const runsByPair = new Map<string, LedgerRun[]>();
		const firstSeenByPair = new Map<string, string>();
		const pairsWithRowBeforeDateFirst = new Set<string>();
		const pairs = new Map<string, { readonly fnsku: string; readonly inventoryPoolKey: string }>();
		for (const row of statusRows) {
			if (row.rowKind === "CENTER" || row.fnsku === null || row.inventoryPoolKey === null) {
				continue;
			}
			const key = makeCompositeKey(row.fnsku, row.inventoryPoolKey);
			if (row.rowKind === "PRIOR") {
				pairsWithRowBeforeDateFirst.add(key);
				continue;
			}
			pairs.set(key, { fnsku: row.fnsku, inventoryPoolKey: row.inventoryPoolKey });
			if (row.rowKind === "RUN") {
				if (row.fromPos === null || row.toPos === null) {
					continue;
				}
				const runs = runsByPair.get(key) ?? [];
				runs.push({ fromPos: row.fromPos, toPos: row.toPos });
				runsByPair.set(key, runs);
			} else if (row.firstSeenDate !== null) {
				firstSeenByPair.set(key, row.firstSeenDate);
			}
		}

		for (const store of stores) {
			const inventoryPoolKey = calcInventoryPoolKey(store.countryCode);
			const length = spine.filter((date) => date <= store.ledgerDateLast).length;
			const drafts: AmazonFbaStockoutEpisodeDraft[] = [];
			for (const [key, pair] of pairs) {
				if (pair.inventoryPoolKey !== inventoryPoolKey) {
					continue;
				}
				const runs = (runsByPair.get(key) ?? [])
					.filter((run) => run.fromPos <= length)
					.map((run) => ({ fromPos: run.fromPos, toPos: Math.min(run.toPos, length) }))
					.sort((a, b) => a.fromPos - b.fromPos);
				const firstSeen = firstSeenByPair.get(key);
				const isSeen = firstSeen !== undefined && firstSeen <= store.ledgerDateLast;
				const draftsOfPair = calcLedgerEpisodes({
					spine,
					length,
					runs,
					hasPreviousRecordedDay,
					hasRowBeforeDateFirst: pairsWithRowBeforeDateFirst.has(key),
					isSeen,
				});
				for (const episode of draftsOfPair) {
					drafts.push({
						merchantId,
						marketplaceId: store.marketplaceId,
						fnsku: pair.fnsku,
						episodeType: "CLOSED_OUT",
						stockoutDate: episode.stockoutDate,
						stockoutBasis: episode.stockoutDate === null ? null : "LEDGER_SELLABLE",
						outOnOrBefore: episode.outOnOrBefore,
						backInStockDate: episode.backInStockDate,
						backInStockBasis: episode.backInStockDate === null ? null : "LEDGER_SELLABLE",
						futureSupplyBuyableMax: null,
						isOutOnFirstHistoryRow: false,
						isOpenAtLedgerEnd: episode.backInStockDate === null && store.historyStartsAt !== null,
					});
				}
			}
			draftsByStore.set(store.marketplaceId, drafts);
		}
		return { draftsByStore, storeLedgerMeta, centersWithoutCountry };
	});
}

/**
 * The episodes of one FNSKU and inventory pool over the spine's first `length` days. Positions are 1-based;
 * position 1 is the last recorded day before the range when `hasPreviousRecordedDay`.
 *
 * An episode already out at position 1 needs `hasRowBeforeDateFirst`: an FNSKU with no ledger row in the
 * inventory pool before the range was first received in it, and a first receipt is not a return to stock.
 */
function calcLedgerEpisodes(input: {
	readonly spine: readonly string[];
	readonly length: number;
	readonly runs: readonly LedgerRun[];
	readonly hasPreviousRecordedDay: boolean;
	readonly hasRowBeforeDateFirst: boolean;
	readonly isSeen: boolean;
}): readonly LedgerEpisodeDates[] {
	const { spine, length, runs } = input;
	function dateAt(position: number): string | null {
		return spine[position - 1] ?? null;
	}
	const episodes: LedgerEpisodeDates[] = [];
	const firstRun = runs[0];
	if (
		input.hasPreviousRecordedDay && input.hasRowBeforeDateFirst && input.isSeen &&
		(firstRun === undefined || firstRun.fromPos !== 1)
	) {
		episodes.push({
			stockoutDate: null,
			outOnOrBefore: dateAt(1),
			backInStockDate: firstRun === undefined ? null : dateAt(firstRun.fromPos),
		});
	}
	runs.forEach((run, index) => {
		if (run.toPos >= length) {
			return;
		}
		const nextRun = runs[index + 1];
		episodes.push({
			stockoutDate: dateAt(run.toPos + 1),
			outOnOrBefore: null,
			backInStockDate: nextRun === undefined ? null : dateAt(nextRun.fromPos),
		});
	});
	return episodes;
}

/** One inventory pool's read: the merchant's centers in it and the last day one of its stores needs. */
interface LedgerInventoryPoolRead {
	readonly inventoryPoolKey: string;
	readonly centers: readonly string[];
	readonly dateLast: string;
}

/**
 * L3: per FNSKU and inventory pool, the runs of recorded days in stock, the first day seen, and whether the FNSKU
 * had a ledger row in the inventory pool before the range.
 */
function buildLedgerStatusQuery(input: {
	readonly merchantId: string;
	readonly ledgerDateFirst: string;
	readonly previousRecordedDay: string | null;
	readonly spine: readonly string[];
	readonly inventoryPoolReads: readonly LedgerInventoryPoolRead[];
	/** The probe's centers with no country, read up to the latest inventory pool's last day and only reported. */
	readonly centersWithoutCountry: readonly string[];
	readonly fnskus: readonly string[] | null;
}): RawBuilder<LedgerStatusRow> {
	const { merchantId, ledgerDateFirst } = input;
	const inventoryPoolKeys = input.inventoryPoolReads.map((read) => read.inventoryPoolKey);
	const dateLast = input.inventoryPoolReads.map((read) => read.dateLast).reduce((a, b) => (a > b ? a : b));
	const inventoryPoolFilter = ksql.join(
		[
			...input.inventoryPoolReads.map((read) =>
				ksql`(h."fulfillmentCenter" = ANY(${
					ksql.val(read.centers)
				}::text[]) AND h."date" <= ${read.dateLast}::date)`
			),
			// Rows of centers with no country: they reach "located" with no inventory pool key and only name the center.
			...(input.centersWithoutCountry.length === 0
				? []
				: [ksql`h."fulfillmentCenter" = ANY(${ksql.val(input.centersWithoutCountry)}::text[])`]),
		],
		ksql` OR `,
	);
	const blocks: RawBuilder<unknown>[] = [ksql`
"summaryRows" AS (
  SELECT h."fulfillmentCenter", h."fnsku", h."date", h."endingWarehouseBalance"
  FROM "amzfact_fnsku_ledger_history" AS h
  WHERE h."merchantId" = ${merchantId}
    AND h."date" >= ${ledgerDateFirst}::date AND h."date" <= ${dateLast}::date
    AND h."disposition" = 'SELLABLE'
    AND (${inventoryPoolFilter})
    ${input.fnskus === null ? ksql`` : ksql`AND h."fnsku" = ANY(${ksql.val(input.fnskus)}::text[])`}
)`];
	const sources: RawBuilder<unknown>[] = [ksql`SELECT * FROM "summaryRows"`];
	// The keys with a ledger row dated before the range.
	const priorSources: RawBuilder<unknown>[] = [];
	if (input.previousRecordedDay !== null) {
		// Any probe row marks a prior ledger row; only rows of the previous recorded day are status rows.
		blocks.push(ksql`
"edgeProbe" AS (
  SELECT k."fulfillmentCenter", k."fnsku", p."date", p."endingWarehouseBalance"
  FROM (
    SELECT DISTINCT s."fulfillmentCenter", s."fnsku" FROM "summaryRows" AS s
    WHERE s."fulfillmentCenter" <> ALL(${ksql.val(input.centersWithoutCountry)}::text[])
  ) AS k
  CROSS JOIN LATERAL (
    SELECT p."date", p."endingWarehouseBalance"
    FROM "amzfact_fnsku_ledger_history" AS p
    WHERE p."merchantId" = ${merchantId} AND p."fulfillmentCenter" = k."fulfillmentCenter"
      AND p."fnsku" = k."fnsku" AND p."disposition" = 'SELLABLE' AND p."date" < ${ledgerDateFirst}::date
    ORDER BY p."date" DESC
    LIMIT 1
  ) AS p
),
"edgeRows" AS (
  SELECT ep.* FROM "edgeProbe" AS ep WHERE ep."date" = ${input.previousRecordedDay}::date
)`);
		sources.push(ksql`SELECT * FROM "edgeRows"`);
		priorSources.push(ksql`SELECT ep."fulfillmentCenter", ep."fnsku" FROM "edgeProbe" AS ep`);
	}
	const priorBlock = priorSources.length === 0 ? ksql`` : ksql`,
"priorKeys" AS (
  ${ksql.join(priorSources, ksql` UNION `)}
)`;
	const priorSelect = priorSources.length === 0 ? ksql`` : ksql`
UNION ALL
SELECT DISTINCT 'PRIOR'::text, p."fnsku", ${inventoryPoolKeyOf(ksql.ref("c.countryCode"))},
       NULL::int, NULL::int, NULL::text, NULL::text
FROM "priorKeys" AS p
JOIN "amazon_fulfillment_center" AS c ON c."fulfillmentCenter" = p."fulfillmentCenter"
WHERE ${inventoryPoolKeyOf(ksql.ref("c.countryCode"))} = ANY(${ksql.val(inventoryPoolKeys)}::text[])`;
	return ksql<LedgerStatusRow>`
WITH
${ksql.join(blocks, ksql`,`)},
"statusRows" AS (
  ${ksql.join(sources, ksql` UNION ALL `)}
)${priorBlock},
"located" AS MATERIALIZED (
  SELECT r."fulfillmentCenter", r."fnsku", r."date", r."endingWarehouseBalance", c."countryCode",
         ${inventoryPoolKeyOf(ksql.ref("c.countryCode"))} AS "inventoryPoolKey"
  FROM "statusRows" AS r
  LEFT JOIN "amazon_fulfillment_center" AS c ON c."fulfillmentCenter" = r."fulfillmentCenter"
),
"spine" AS (
  SELECT s."date", s."pos"::int AS "pos"
  FROM unnest(${ksql.val(input.spine)}::date[]) WITH ORDINALITY AS s("date", "pos")
),
"inStock" AS (
  SELECT l."fnsku", l."inventoryPoolKey", sp."pos"
  FROM "located" AS l
  JOIN "spine" AS sp ON sp."date" = l."date"
  WHERE l."inventoryPoolKey" = ANY(${ksql.val(inventoryPoolKeys)}::text[])
  GROUP BY l."fnsku", l."inventoryPoolKey", sp."pos"
  HAVING bool_or(l."endingWarehouseBalance" > 0)
),
"runs" AS (
  SELECT i."fnsku", i."inventoryPoolKey", min(i."pos") AS "fromPos", max(i."pos") AS "toPos"
  FROM (
    SELECT n.*, n."pos" - row_number() OVER (PARTITION BY n."fnsku", n."inventoryPoolKey" ORDER BY n."pos") AS "island"
    FROM "inStock" AS n
  ) AS i
  GROUP BY i."fnsku", i."inventoryPoolKey", i."island"
)
SELECT 'RUN'::text AS "rowKind", r."fnsku", r."inventoryPoolKey", r."fromPos"::int AS "fromPos",
       r."toPos"::int AS "toPos", NULL::text AS "firstSeenDate", NULL::text AS "fulfillmentCenter"
FROM "runs" AS r
UNION ALL
SELECT 'SEEN'::text, l."fnsku", l."inventoryPoolKey", NULL::int, NULL::int, min(l."date")::text, NULL::text
FROM "located" AS l
WHERE l."inventoryPoolKey" = ANY(${ksql.val(inventoryPoolKeys)}::text[]) AND l."date" >= ${ledgerDateFirst}::date
GROUP BY l."fnsku", l."inventoryPoolKey"
UNION ALL
SELECT 'CENTER'::text, NULL::text, NULL::text, NULL::int, NULL::int, NULL::text, l."fulfillmentCenter"
FROM "located" AS l
WHERE l."inventoryPoolKey" IS NULL
GROUP BY l."fulfillmentCenter"${priorSelect}
`;
}
