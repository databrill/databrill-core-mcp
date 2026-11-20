/**
 * Stockout episodes per merchant, marketplace and FNSKU: when a product ran out of FBA stock, and whether it
 * came back. Read from `amzfact_fnsku_fbaInventory_history` from the day a store's history starts
 * (`loadStockoutsFromFbaInventoryHistory.ts`), and from the FBA inventory ledger for the days of the range
 * before that (`loadStockoutsFromFbaLedger.ts`). An episode open at the end of a store's ledger days and one
 * out on the FNSKU's first history row are one episode.
 *
 * Provenance: this tool was authored in `mcp-local` first, under the exception in `mcp-local/AGENTS.md`
 * § "Feature-origination rule". Its stockout episodes have no reference implementation elsewhere; its
 * correctness is proven by its integration tests against Postgres, not by parity.
 *
 * No read goes back through all of history. Every read is bounded by the rows in the requested range plus
 * one probe per FNSKU or ledger key that has rows in it.
 */
import { resolveProductsForStores } from "../../productSelection.ts";
import { createCanonicalQueryBuilder, probeRelations } from "@jsr/databrill__core-pg-kysely/canonical";
import { Effect, Result } from "effect";
import { sql as ksql } from "kysely";
import { DateTime } from "luxon";
import type { Sql } from "postgres";
import { marketplaceIdToMarketplaceInfo } from "../../amazonConstants.ts";
import { makeCompositeKey } from "../../makeCompositeKey.ts";
import { runCompiled } from "../../runCompiled.ts";
import {
	type DateRange,
	parseWhenRange,
	type ResolvedStore,
	resolveStores,
	resolveTrailingRange,
} from "../loadAds/loadAds.ts";
import { loadStockoutsFromFbaInventoryHistory } from "./loadStockoutsFromFbaInventoryHistory.ts";
import {
	addDaysToIsoDate,
	type AmazonFbaLedgerStoreMeta,
	type AmazonFbaLedgerStoreRange,
	calcLedgerCenterCountryCodes,
	loadStockoutsFromFbaLedger,
} from "./loadStockoutsFromFbaLedger.ts";
import type {
	AmazonFbaStockoutEpisode,
	AmazonFbaStockoutEpisodeDraft,
	AmazonFbaStockoutsStoreMeta,
	LoadAmazonFbaStockoutsParams,
	LoadAmazonFbaStockoutsResult,
} from "./types.ts";

const REQUIRED_TABLES = [
	"amzfact_fnsku_fbaInventory_history",
	"amzfact_fnsku_fbaInventory_latest",
	"amzfact_sku_identity",
	"amzfact_fnsku_ledger_history",
	"amazon_fulfillment_center",
] as const;

const DEFAULT_WHEN = "P90D";
const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 1000;

const SOURCE = "Amazon FBA inventory history; Amazon FBA inventory ledger";

const CRITERION = "From FBA inventory history: a CLOSED_OUT episode starts on the first day fulfillable closes at " +
	"zero after a day closing in stock, and ends on the first later day closing in stock. A day whose whole-day " +
	"low is zero but which closed in stock, after a day closing in stock, is a one-day INTRADAY_DIP; a " +
	"back-in-stock day belongs to its episode and is not also a dip. Future supply never decides a stockout. " +
	"From the FBA inventory ledger, for the days of the range before a store's history starts: a CLOSED_OUT " +
	"episode is a run of recorded days on which no fulfillment center of the store's center countries holds a " +
	"SELLABLE ending balance above zero, after a day on which one did.";

const GRAIN = "One row per merchant, marketplace, FNSKU and episode. asin and sellerSkus label the FNSKU; an " +
	"FNSKU with several seller SKUs is one row. A ledger episode belongs to a store when the store lists the " +
	"FNSKU in amzfact_fnsku_fbaInventory_latest, or lists no FNSKU there at all.";

const NOTES: readonly string[] = [
	"FBA inventory history has a row only on a day the FNSKU's inventory changed; a missing day means unchanged " +
	"or not polled, which nothing distinguishes.",
	"An FNSKU whose inventory did not change in the range has no history row there and no episode; a ledger " +
	"FNSKU with no SELLABLE row in its range likewise has no episode.",
	"NULL quantities in the history are not reported and are read as 0.",
	"Ledger episodes are a lower bound: units reserved for orders, transfers or center processing count in the " +
	"ledger balance, so a stockout with reserved units is not visible there, and no ledger episode does not mean " +
	"in stock.",
	"A day with no ledger row at all for the merchant is a missing summary report: not recorded and never out; " +
	"an episode whose days on both sides of it are out spans it. Such days are listed per store in " +
	"ledgerDaysWithoutReport.",
	"The ledger is read up to ledgerSummaryDateLast, the merchant's newest summary day; a store's ledger days " +
	"after it are in neither source. For a store with no FBA inventory history, a ledger episode still out was out " +
	"on that day.",
	"ledgerCenterCountryCodes lists the countries whose centers count for a store: the Pan-European FBA " +
	"countries pooled for a pan-European marketplace, GB on its own, and every other marketplace's own country. " +
	"ledgerCentersWithoutCountry names the centers of the merchant's ledger with no country in " +
	"amazon_fulfillment_center, or missing from it, that have rows on the ledger days read; they count in none.",
	"An episode already out where its source starts being read has a null stockoutDate; outOnOrBefore is a day " +
	"on which it was already out.",
	"An episode with no backInStockDate is reported as still out only when the range reaches the store's today; " +
	"daysOut is null unless the start is known and either the end is known or the episode is still out.",
	"historyStartsBeforeDateFirst is true when the store has FBA inventory history before dateFirst; otherwise " +
	"historyStartsAt is its first history day in the range, or null when it has none up to dateLast, and the " +
	"days before it come from the ledger.",
	"asin and sellerSkus are current mappings.",
];

function calcDaysBetween(dateFirst: string, dateLast: string): number {
	return Math.round(
		DateTime.fromISO(dateLast, { zone: "utc" }).diff(DateTime.fromISO(dateFirst, { zone: "utc" }), "days").days,
	);
}

function isIsoDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value, { zone: "utc" }).isValid;
}

export function parseLimit(value: number | undefined): Result.Result<number, Error> {
	const limit = value ?? DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		return Result.fail(new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`));
	}
	return Result.succeed(limit);
}

export function parseStores(value: string): Result.Result<string, Error> {
	if (value.trim() === "") {
		return Result.fail(new Error("stores is required"));
	}
	return Result.succeed(value);
}

/** The range from `when`, a duration ending on `dateLatest`; refused when it ends after it or is reversed. */
export function calcRange(when: string, dateLatest: string): Result.Result<DateRange, Error> {
	return Result.gen(function* () {
		const parsed = yield* parseWhenRange(when);
		const range = parsed.kind === "explicit"
			? parsed.range
			: yield* resolveTrailingRange(parsed.duration, dateLatest);
		if (!isIsoDate(range.dateFirst) || !isIsoDate(range.dateLast)) {
			return yield* Result.fail(new Error(`when must name calendar dates; got ${when}`));
		}
		if (range.dateFirst > range.dateLast) {
			return yield* Result.fail(new Error(`when is reversed: ${range.dateFirst} is after ${range.dateLast}`));
		}
		if (range.dateLast > dateLatest) {
			return yield* Result.fail(
				new Error(
					`when ends on ${range.dateLast}, after ${dateLatest}, the latest local today of the selected stores`,
				),
			);
		}
		return range;
	});
}

function parseProductTokens(value: string | undefined): readonly string[] {
	return (value ?? "").split(",").map((token) => token.trim()).filter((token) => token !== "");
}

interface StoreToday {
	readonly store: ResolvedStore;
	readonly today: string;
}

export function calcStoreTodays(stores: readonly ResolvedStore[]): Result.Result<readonly StoreToday[], Error> {
	const out: StoreToday[] = [];
	for (const store of stores) {
		const timeZone = marketplaceIdToMarketplaceInfo[store.marketplaceId]?.timeZone;
		if (timeZone === undefined) {
			return Result.fail(new Error(`No time zone is known for marketplace ${store.marketplaceId}`));
		}
		const today = DateTime.now().setZone(timeZone).toISODate();
		if (today === null) {
			return Result.fail(new Error(`Could not compute today in ${timeZone}`));
		}
		out.push({ store, today });
	}
	return Result.succeed(out);
}

interface StoreProbeRow {
	readonly historyStartsBeforeDateFirst: boolean;
	readonly firstHistoryDateInRange: string | null;
	readonly hasInventoryLatest: boolean;
}

interface StoreState {
	readonly store: ResolvedStore;
	readonly today: string;
	readonly historyStartsBeforeDateFirst: boolean;
	readonly historyStartsAt: string | null;
	readonly hasInventoryLatest: boolean;
	/** The store's ledger days, `dateFirst`..`ledgerDateLast`; null when the ledger is not read for it. */
	readonly ledgerDateLast: string | null;
}

/** The store's ledger days end the day before its history starts, or on `dateLast` when it has none. */
function calcLedgerDateLast(input: {
	readonly dateFirst: string;
	readonly dateLast: string;
	readonly historyStartsBeforeDateFirst: boolean;
	readonly historyStartsAt: string | null;
}): string | null {
	if (input.historyStartsBeforeDateFirst) {
		return null;
	}
	if (input.historyStartsAt === null) {
		return input.dateLast;
	}
	if (input.historyStartsAt > input.dateFirst) {
		return addDaysToIsoDate(input.historyStartsAt, -1);
	}
	return null;
}

function compareEpisodes(a: AmazonFbaStockoutEpisode, b: AmazonFbaStockoutEpisode): number {
	if (a.isStillOut !== b.isStillOut) {
		return a.isStillOut ? -1 : 1;
	}
	const startA = a.stockoutDate ?? a.outOnOrBefore ?? "";
	const startB = b.stockoutDate ?? b.outOnOrBefore ?? "";
	if (startA !== startB) {
		return startA > startB ? -1 : 1;
	}
	for (
		const [x, y] of [
			[a.merchantId, b.merchantId],
			[a.marketplaceId, b.marketplaceId],
			[a.fnsku, b.fnsku],
			[a.episodeType, b.episodeType],
		] as const
	) {
		if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

/**
 * Merge one store's history and ledger drafts: an episode open at the end of the store's ledger days ends on
 * the FNSKU's first history row, joined with the history episode out on that row when there is one.
 */
function calcMergedStoreDrafts(input: {
	readonly historyStartsAt: string | null;
	readonly historyDrafts: readonly AmazonFbaStockoutEpisodeDraft[];
	readonly firstRowsInStock: ReadonlyMap<string, string>;
	readonly ledgerDrafts: readonly AmazonFbaStockoutEpisodeDraft[];
}): readonly AmazonFbaStockoutEpisodeDraft[] {
	const outOnFirstRow = new Map<string, AmazonFbaStockoutEpisodeDraft>();
	const historyDrafts: AmazonFbaStockoutEpisodeDraft[] = [];
	for (const draft of input.historyDrafts) {
		if (draft.isOutOnFirstHistoryRow) {
			outOnFirstRow.set(draft.fnsku, draft);
		} else {
			historyDrafts.push(draft);
		}
	}
	const merged: AmazonFbaStockoutEpisodeDraft[] = [];
	for (const ledgerDraft of input.ledgerDrafts) {
		if (!ledgerDraft.isOpenAtLedgerEnd) {
			merged.push(ledgerDraft);
			continue;
		}
		const historyDraft = outOnFirstRow.get(ledgerDraft.fnsku);
		if (historyDraft !== undefined) {
			outOnFirstRow.delete(ledgerDraft.fnsku);
			merged.push({
				...ledgerDraft,
				backInStockDate: historyDraft.backInStockDate,
				backInStockBasis: historyDraft.backInStockBasis,
				futureSupplyBuyableMax: historyDraft.futureSupplyBuyableMax,
				isOpenAtLedgerEnd: false,
			});
			continue;
		}
		const firstRowInStock = input.firstRowsInStock.get(ledgerDraft.fnsku);
		if (firstRowInStock !== undefined) {
			merged.push({
				...ledgerDraft,
				backInStockDate: firstRowInStock,
				backInStockBasis: "FULFILLABLE",
				isOpenAtLedgerEnd: false,
			});
			continue;
		}
		merged.push(ledgerDraft);
	}
	for (const historyDraft of outOnFirstRow.values()) {
		// Out on the first history day with no ledger episode open: already out; a later first row is a new product.
		if (input.historyStartsAt !== null && historyDraft.outOnOrBefore === input.historyStartsAt) {
			merged.push({ ...historyDraft, isOutOnFirstHistoryRow: false });
		}
	}
	return [...merged, ...historyDrafts];
}

function calcEpisode(input: {
	readonly draft: AmazonFbaStockoutEpisodeDraft;
	readonly store: ResolvedStore;
	readonly today: string;
	readonly dateLast: string;
}): AmazonFbaStockoutEpisode {
	const { draft, today } = input;
	const isStillOut = draft.backInStockDate === null && !draft.isOpenAtLedgerEnd && input.dateLast >= today;
	let daysOut: number | null = null;
	if (draft.stockoutDate !== null && draft.backInStockDate !== null) {
		daysOut = calcDaysBetween(draft.stockoutDate, draft.backInStockDate);
	} else if (draft.stockoutDate !== null && isStillOut) {
		daysOut = calcDaysBetween(draft.stockoutDate, today);
	}
	return {
		merchantId: draft.merchantId,
		marketplaceId: draft.marketplaceId,
		countryCode: input.store.countryCode,
		fnsku: draft.fnsku,
		asin: null,
		sellerSkus: [],
		episodeType: draft.episodeType,
		stockoutDate: draft.stockoutDate,
		stockoutBasis: draft.stockoutBasis,
		outOnOrBefore: draft.outOnOrBefore,
		backInStockDate: draft.backInStockDate,
		backInStockBasis: draft.backInStockBasis,
		isStillOut,
		daysOut,
		futureSupplyBuyableMax: draft.futureSupplyBuyableMax,
	};
}

/** Load FBA stockout episodes per merchant, marketplace and FNSKU using an injected connection. */
export function loadAmazonFbaStockouts(
	params: LoadAmazonFbaStockoutsParams,
	sql: Sql,
): Effect.Effect<LoadAmazonFbaStockoutsResult, Error> {
	return Effect.gen(function* () {
		const storesSpec = yield* Effect.fromResult(parseStores(params.stores));
		const limit = yield* Effect.fromResult(parseLimit(params.limit));
		const tokens = parseProductTokens(params.products);

		const resolvedStores = yield* resolveStores(storesSpec, sql);
		const storeTodays = yield* Effect.fromResult(calcStoreTodays(resolvedStores));
		const dateLatest = storeTodays.map((entry) => entry.today).sort().at(-1);
		if (dateLatest === undefined) {
			return yield* Effect.fail(new Error("No stores resolved"));
		}
		const { dateFirst, dateLast } = yield* Effect.fromResult(calcRange(params.when ?? DEFAULT_WHEN, dateLatest));

		const db = createCanonicalQueryBuilder();
		const present = yield* probeRelations(db, sql, [...REQUIRED_TABLES]);
		const missingTables = REQUIRED_TABLES.filter((table) => !present.has(table));
		const metaBase = {
			source: SOURCE,
			criterion: CRITERION,
			grain: GRAIN,
			dateFirst,
			dateLast,
			limit,
			missingTables,
			notes: NOTES,
		} as const;
		if (missingTables.length > 0) {
			return {
				meta: {
					...metaBase,
					stores: [],
					ledgerCentersWithoutCountry: [],
					rowCount: 0,
					isTruncated: false,
				},
				data: [],
			};
		}

		const merchantIds = [...new Set(resolvedStores.map((store) => store.merchantId))];

		// Products: each token is an FNSKU candidate; seller SKUs and ASINs map through amzfact_sku_identity (I1).
		let scopedFnskus: ReadonlyMap<string, readonly string[]> | null = null;
		if (tokens.length > 0) {
			const selection = yield* resolveProductsForStores(tokens.join(","), sql, resolvedStores, {
				warnOnMissingFamily: false,
			});
			const byStore = new Map<string, readonly string[]>();
			for (const store of resolvedStores) {
				const asins = selection.get(store.marketplaceId) ?? [];
				const identityRows = yield* runCompiled(sql, () =>
					ksql<{ readonly fnsku: string }>`
SELECT DISTINCT i."fnsku" FROM "amzfact_sku_identity" AS i
WHERE i."merchantId" = ${store.merchantId} AND i."fnsku" IS NOT NULL
 AND (i."sku" = ANY(${ksql.val([...tokens])}::text[]) OR i."asin" = ANY(${ksql.val([...asins])}::text[]))
`.compile(db));
				byStore.set(
					makeCompositeKey(store.merchantId, store.marketplaceId),
					[...new Set([...tokens, ...identityRows.map((row) => row.fnsku)])].sort(),
				);
			}
			scopedFnskus = byStore;
		}
		function fnskusOf(store: ResolvedStore): readonly string[] | null {
			return scopedFnskus === null
				? null
				: (scopedFnskus.get(makeCompositeKey(store.merchantId, store.marketplaceId)) ?? []);
		}

		// S1: per store, history before the range, its first history day in range, and any FNSKU in _latest.
		const storeStates: StoreState[] = [];
		for (const { store, today } of storeTodays) {
			const probeRows = yield* runCompiled(sql, () =>
				ksql<StoreProbeRow>`
SELECT
  EXISTS (
    SELECT 1 FROM "amzfact_fnsku_fbaInventory_history" AS h
    WHERE h."merchantId" = ${store.merchantId} AND h."marketplaceId" = ${store.marketplaceId}
      AND h."date" < ${dateFirst}::date
  ) AS "historyStartsBeforeDateFirst",
  (
    SELECT min(h."date")::text FROM "amzfact_fnsku_fbaInventory_history" AS h
    WHERE h."merchantId" = ${store.merchantId} AND h."marketplaceId" = ${store.marketplaceId}
      AND h."date" >= ${dateFirst}::date AND h."date" <= ${dateLast}::date
  ) AS "firstHistoryDateInRange",
  EXISTS (
    SELECT 1 FROM "amzfact_fnsku_fbaInventory_latest" AS l
    WHERE l."merchantId" = ${store.merchantId} AND l."marketplaceId" = ${store.marketplaceId}
  ) AS "hasInventoryLatest"
`.compile(db));
			const probe = probeRows[0];
			const historyStartsBeforeDateFirst = probe?.historyStartsBeforeDateFirst ?? false;
			const historyStartsAt = historyStartsBeforeDateFirst ? null : (probe?.firstHistoryDateInRange ?? null);
			storeStates.push({
				store,
				today,
				historyStartsBeforeDateFirst,
				historyStartsAt,
				hasInventoryLatest: probe?.hasInventoryLatest ?? false,
				ledgerDateLast: calcLedgerDateLast({
					dateFirst,
					dateLast,
					historyStartsBeforeDateFirst,
					historyStartsAt,
				}),
			});
		}

		// The history read, per store with history rows in range.
		const historyByStore = new Map<
			string,
			{
				readonly drafts: readonly AmazonFbaStockoutEpisodeDraft[];
				readonly firstRowsInStock: ReadonlyMap<string, string>;
			}
		>();
		for (const state of storeStates) {
			const fnskus = fnskusOf(state.store);
			if (!state.historyStartsBeforeDateFirst && state.historyStartsAt === null) {
				continue;
			}
			if (fnskus !== null && fnskus.length === 0) {
				continue;
			}
			const history = yield* loadStockoutsFromFbaInventoryHistory({
				sql,
				db,
				merchantId: state.store.merchantId,
				marketplaceId: state.store.marketplaceId,
				dateFirst,
				dateLast,
				historyStartsBeforeDateFirst: state.historyStartsBeforeDateFirst,
				fnskus,
			});
			historyByStore.set(makeCompositeKey(state.store.merchantId, state.store.marketplaceId), {
				drafts: history.drafts,
				firstRowsInStock: new Map(history.firstRowsInStock.map((row) => [row.fnsku, row.date])),
			});
		}

		// The ledger read, per merchant whose stores have ledger days.
		const ledgerDraftsByStore = new Map<string, readonly AmazonFbaStockoutEpisodeDraft[]>();
		const ledgerMetaByStore = new Map<string, AmazonFbaLedgerStoreMeta>();
		const centersWithoutCountry = new Set<string>();
		for (const merchantId of merchantIds) {
			const fnskus = scopedFnskus === null ? null : [
				...new Set(
					resolvedStores.filter((store) => store.merchantId === merchantId).flatMap((store) =>
						fnskusOf(store) ?? []
					),
				),
			];
			const ledgerStores: AmazonFbaLedgerStoreRange[] = [];
			for (const state of storeStates) {
				if (state.store.merchantId !== merchantId || state.ledgerDateLast === null) {
					continue;
				}
				ledgerStores.push({
					marketplaceId: state.store.marketplaceId,
					countryCode: state.store.countryCode,
					ledgerDateLast: state.ledgerDateLast,
					historyStartsAt: state.historyStartsAt,
				});
			}
			if (ledgerStores.length === 0 || (fnskus !== null && fnskus.length === 0)) {
				continue;
			}
			const ledger = yield* loadStockoutsFromFbaLedger({
				sql,
				db,
				merchantId,
				dateFirst,
				stores: ledgerStores,
				fnskus,
			});
			for (const [marketplaceId, drafts] of ledger.draftsByStore) {
				ledgerDraftsByStore.set(makeCompositeKey(merchantId, marketplaceId), drafts);
			}
			for (const [marketplaceId, meta] of ledger.storeLedgerMeta) {
				ledgerMetaByStore.set(makeCompositeKey(merchantId, marketplaceId), meta);
			}
			for (const center of ledger.centersWithoutCountry) {
				centersWithoutCountry.add(center);
			}
		}

		const episodes: AmazonFbaStockoutEpisode[] = [];
		for (const state of storeStates) {
			const storeKey = makeCompositeKey(state.store.merchantId, state.store.marketplaceId);
			const selectedFnskus = fnskusOf(state.store);
			const ledgerDraftsAll = (ledgerDraftsByStore.get(storeKey) ?? []).filter((draft) =>
				selectedFnskus === null || selectedFnskus.includes(draft.fnsku)
			);
			// M1: a ledger episode belongs to the store when _latest lists the FNSKU for it, or lists none.
			let ledgerDrafts = ledgerDraftsAll;
			if (ledgerDraftsAll.length > 0 && state.hasInventoryLatest) {
				const candidates = [...new Set(ledgerDraftsAll.map((draft) => draft.fnsku))];
				const listedRows = yield* runCompiled(sql, () =>
					ksql<{ readonly fnsku: string }>`
SELECT k."fnsku"
FROM unnest(${ksql.val(candidates)}::text[]) AS k("fnsku")
WHERE EXISTS (
  SELECT 1 FROM "amzfact_fnsku_fbaInventory_latest" AS l
  WHERE l."merchantId" = ${state.store.merchantId} AND l."marketplaceId" = ${state.store.marketplaceId}
    AND l."fnsku" = k."fnsku"
)
`.compile(db));
				const listed = new Set(listedRows.map((row) => row.fnsku));
				ledgerDrafts = ledgerDraftsAll.filter((draft) => listed.has(draft.fnsku));
			}
			const history = historyByStore.get(storeKey);
			const drafts = calcMergedStoreDrafts({
				historyStartsAt: state.historyStartsAt,
				historyDrafts: history?.drafts ?? [],
				firstRowsInStock: history?.firstRowsInStock ?? new Map(),
				ledgerDrafts,
			});
			for (const draft of drafts) {
				episodes.push(calcEpisode({ draft, store: state.store, today: state.today, dateLast }));
			}
		}

		episodes.sort(compareEpisodes);
		const page = episodes.slice(0, limit);

		// Labels, only for the returned episodes: asin (A1) and sellerSkus (I3).
		const asinByKey = new Map<string, string | null>();
		const sellerSkusByKey = new Map<string, readonly string[]>();
		if (page.length > 0) {
			const asinRows = yield* runCompiled(sql, () =>
				ksql<
					{
						readonly merchantId: string;
						readonly marketplaceId: string;
						readonly fnsku: string;
						readonly asin: string | null;
					}
				>`
SELECT k."merchantId", k."marketplaceId", k."fnsku", l."asin"
FROM unnest(${ksql.val(page.map((e) => e.merchantId))}::text[], ${
					ksql.val(page.map((e) => e.marketplaceId))
				}::text[], ${ksql.val(page.map((e) => e.fnsku))}::text[]) AS k("merchantId", "marketplaceId", "fnsku")
JOIN "amzfact_fnsku_fbaInventory_latest" AS l
  ON l."merchantId" = k."merchantId" AND l."marketplaceId" = k."marketplaceId" AND l."fnsku" = k."fnsku"
`.compile(db));
			for (const row of asinRows) {
				asinByKey.set(makeCompositeKey(row.merchantId, row.marketplaceId, row.fnsku), row.asin);
			}
			const skuRows = yield* runCompiled(
				sql,
				() =>
					ksql<
						{ readonly merchantId: string; readonly fnsku: string; readonly sellerSkus: readonly string[] }
					>`
SELECT i."merchantId", i."fnsku", array_agg(i."sku" ORDER BY i."sku") AS "sellerSkus"
FROM "amzfact_sku_identity" AS i
WHERE i."merchantId" = ANY(${ksql.val([...new Set(page.map((e) => e.merchantId))])}::text[])
  AND i."fnsku" = ANY(${ksql.val([...new Set(page.map((e) => e.fnsku))])}::text[])
GROUP BY i."merchantId", i."fnsku"
`.compile(db),
			);
			for (const row of skuRows) {
				sellerSkusByKey.set(makeCompositeKey(row.merchantId, row.fnsku), row.sellerSkus);
			}
		}
		const data = page.map((episode) => ({
			...episode,
			asin: asinByKey.get(makeCompositeKey(episode.merchantId, episode.marketplaceId, episode.fnsku)) ?? null,
			sellerSkus: sellerSkusByKey.get(makeCompositeKey(episode.merchantId, episode.fnsku)) ?? [],
		}));

		const stores: AmazonFbaStockoutsStoreMeta[] = storeStates.map((state) => {
			const ledgerMeta = ledgerMetaByStore.get(
				makeCompositeKey(state.store.merchantId, state.store.marketplaceId),
			);
			return {
				merchantId: state.store.merchantId,
				marketplaceId: state.store.marketplaceId,
				countryCode: state.store.countryCode,
				today: state.today,
				historyStartsBeforeDateFirst: state.historyStartsBeforeDateFirst,
				historyStartsAt: state.historyStartsAt,
				ledgerDateFirst: state.ledgerDateLast === null ? null : dateFirst,
				ledgerDateLast: state.ledgerDateLast,
				ledgerSummaryDateLast: ledgerMeta?.ledgerSummaryDateLast ?? null,
				ledgerDaysWithoutReport: ledgerMeta?.ledgerDaysWithoutReport ?? [],
				ledgerCenterCountryCodes: state.ledgerDateLast === null
					? []
					: calcLedgerCenterCountryCodes(state.store.countryCode),
			};
		});

		return {
			meta: {
				...metaBase,
				stores,
				ledgerCentersWithoutCountry: [...centersWithoutCountry].sort(),
				rowCount: data.length,
				isTruncated: episodes.length > limit,
			},
			data,
		};
	});
}
