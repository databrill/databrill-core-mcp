/**
 * CLI frontend (dev / agency / parity). Runs under bun and deno:
 *   bun run bin/cli.ts salesDropDiagnosis --all-stores --format json
 *   deno run -A bin/cli.ts salesDropDiagnosis --stores DE,US
 *
 * Same `(config, sql)` core as the MCP tool. Connection: a single POSTGRES_URL,
 * or — when DATABRILL_CONFIG is set — the workspace picked by `--wsid` (or
 * inferred from `--stores`), matching the MCP server's routing.
 */

import "dotenv/config";
import { Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Option } from "effect";
import type { Sql } from "postgres";
import { loadConfig } from "../src/config.ts";
import { createSqlProvider } from "../src/db.ts";
import { loadAds } from "../src/tools/loadAds/loadAds.ts";
import { loadTraffic } from "../src/tools/loadTraffic/load.ts";
import { loadSqp } from "../src/tools/loadSqp/load.ts";
import { loadRank } from "../src/tools/loadRank/load.ts";
import { loadEconomics } from "../src/tools/loadEconomics/load.ts";
import { loadInventoryPacing } from "../src/tools/inventoryPacing/load.ts";
import { load } from "../src/tools/salesDropDiagnosis/load.ts";
import { render } from "../src/tools/salesDropDiagnosis/render.ts";
import type { OutputFormat } from "../src/tools/salesDropDiagnosis/types.ts";

const provider = createSqlProvider(loadConfig());

/** Shared `--wsid` option. Only meaningful with DATABRILL_CONFIG; ignored otherwise. */
const wsidOption = Options.text("wsid").pipe(
	Options.withDescription("Workspace id — needed only with DATABRILL_CONFIG when the stores span workspaces"),
	Options.optional,
);

/** Resolve the connection for a command from its `--wsid` and `--stores` options. */
function resolveSql(o: { wsid: Option.Option<string>; stores?: unknown }): Sql {
	const stores = typeof o.stores === "string"
		? o.stores
		: Option.isOption(o.stores)
		? Option.getOrUndefined(o.stores)
		: undefined;
	return provider.getSqlForArgs({ wsid: Option.getOrUndefined(o.wsid), stores });
}

const loadAdsCommand = Command.make(
	"loadAds",
	{
		wsid: wsidOption,
		stores: Options.text("stores").pipe(
			Options.withDescription("country code (US), region (na,eu,fe), marketplaceId, '*', or {merchantId}-{scope}"),
		),
		when: Options.text("when").pipe(
			Options.withDescription("ISO 8601 interval/duration: 2026-03-30/2026-04-05, P7D, P4W/2026-04-13"),
		),
		groupBy: Options.text("groupBy").pipe(Options.withDescription("Comma-separated dimensions (asin, family, adType, …)")),
		timeUnit: Options.text("timeUnit").pipe(Options.optional),
		products: Options.text("products").pipe(Options.optional),
		filter: Options.text("filter").pipe(Options.optional),
		derived: Options.boolean("derived").pipe(Options.withDefault(false)),
		nested: Options.boolean("nested").pipe(Options.withDefault(false)),
	},
	(o) =>
		Effect.gen(function* () {
			const sql = resolveSql(o);
			try {
				const result = yield* Effect.promise(() =>
					loadAds({
						stores: o.stores,
						when: o.when,
						groupBy: o.groupBy,
						timeUnit: Option.getOrUndefined(o.timeUnit),
						products: Option.getOrUndefined(o.products),
						filter: Option.getOrUndefined(o.filter),
						derived: o.derived,
						nested: o.nested,
						format: "json",
					}, sql)
				);
				console.log(JSON.stringify(result, null, "\t"));
			} finally {
				yield* Effect.promise(() => provider.endAll());
			}
		}),
).pipe(Command.withDescription("Fetch Amazon advertising metrics aggregated by dimensions (the dbl-metrics-ads loader)"));

const salesDropDiagnosis = Command.make(
	"salesDropDiagnosis",
	{
		wsid: wsidOption,
		stores: Options.text("stores").pipe(
			Options.withDescription("Comma-separated store filter: merchantId, country code, or merchantId-site"),
			Options.optional,
		),
		allStores: Options.boolean("all-stores").pipe(
			Options.withDescription("Include every store with data, not just configured countries"),
			Options.withDefault(false),
		),
		format: Options.choice("format", ["console", "markdown", "json"]).pipe(
			Options.withDescription("Output format"),
			Options.withDefault("console" as const),
		),
		recentDays: Options.integer("recent-days").pipe(Options.withDefault(7)),
		baselineDays: Options.integer("baseline-days").pipe(Options.withDefault(28)),
		dropThreshold: Options.float("drop-threshold").pipe(Options.withDefault(0.10)),
		inventoryRunwayMax: Options.integer("inventory-runway-max").pipe(Options.withDefault(14)),
		skipInventory: Options.boolean("skip-inventory").pipe(Options.withDefault(false)),
	},
	(o) =>
		Effect.gen(function* () {
			const sql = resolveSql(o);
			const storesRaw = Option.getOrUndefined(o.stores);
			try {
				const rows = yield* load({
					stores: storesRaw ? storesRaw.split(",").map((s) => s.trim()).filter(Boolean) : null,
					allStores: o.allStores,
					recentDays: o.recentDays,
					baselineDays: o.baselineDays,
					dropThreshold: o.dropThreshold,
					inventoryRunwayMax: o.inventoryRunwayMax,
					skipInventory: o.skipInventory,
				}, sql);
				render(rows, o.format as OutputFormat);
			} finally {
				yield* Effect.promise(() => provider.endAll());
			}
		}),
).pipe(Command.withDescription("Diagnose why a store's sales dropped: rank traffic/conversion/price causes + signals"));

const loadTrafficCommand = Command.make(
	"loadTraffic",
	{
		wsid: wsidOption,
		stores: Options.text("stores").pipe(Options.withDescription("country code, region, marketplaceId, '*', or {merchantId}-{scope}")),
		when: Options.text("when").pipe(Options.withDescription("ISO interval/duration: P7D, 2026-03-30/2026-04-05")),
		groupBy: Options.text("groupBy").pipe(Options.withDescription("asin (default) | family"), Options.optional),
		timeUnit: Options.text("timeUnit").pipe(Options.withDescription("WEEK (default) | DAY | MONTH"), Options.optional),
		products: Options.text("products").pipe(Options.optional),
	},
	(o) =>
		Effect.gen(function* () {
			const sql = resolveSql(o);
			try {
				const result = yield* Effect.promise(() =>
					loadTraffic({
						stores: o.stores,
						when: o.when,
						groupBy: Option.getOrUndefined(o.groupBy),
						timeUnit: Option.getOrUndefined(o.timeUnit),
						products: Option.getOrUndefined(o.products),
					}, sql)
				);
				console.log(JSON.stringify(result, null, "\t"));
			} finally {
				yield* Effect.promise(() => provider.endAll());
			}
		}),
).pipe(Command.withDescription("Fetch Sales & Traffic metrics (sessions/units/sales/CR) per ASIN or family"));

const loadSqpCommand = Command.make(
	"loadSqp",
	{
		wsid: wsidOption,
		stores: Options.text("stores").pipe(Options.withDescription("country/region/marketplaceId/'*'/{merchantId}-{scope}")),
		when: Options.text("when").pipe(Options.withDescription("ISO interval/duration")),
		products: Options.text("products").pipe(Options.optional),
		timeUnit: Options.text("timeUnit").pipe(Options.withDescription("WEEK (default) | MONTH"), Options.optional),
		keywordLimit: Options.integer("keywordLimit").pipe(Options.optional),
	},
	(o) =>
		Effect.gen(function* () {
			const sql = resolveSql(o);
			try {
				const result = yield* Effect.promise(() =>
					loadSqp({
						stores: o.stores,
						when: o.when,
						products: Option.getOrUndefined(o.products),
						timeUnit: Option.getOrUndefined(o.timeUnit),
						keywordLimit: Option.getOrUndefined(o.keywordLimit),
					}, sql)
				);
				console.log(JSON.stringify(result, null, "\t"));
			} finally {
				yield* Effect.promise(() => provider.endAll());
			}
		}),
).pipe(Command.withDescription("Fetch Search Query Performance: our-vs-market shares + top keywords"));

const loadRankCommand = Command.make(
	"loadRank",
	{
		wsid: wsidOption,
		stores: Options.text("stores").pipe(Options.withDescription("country/region/marketplaceId/'*'/{merchantId}-{scope}")),
		when: Options.text("when").pipe(Options.withDescription("ISO interval/duration")),
		products: Options.text("products").pipe(Options.optional),
	},
	(o) =>
		Effect.gen(function* () {
			const sql = resolveSql(o);
			try {
				const result = yield* Effect.promise(() =>
					loadRank({ stores: o.stores, when: o.when, products: Option.getOrUndefined(o.products) }, sql)
				);
				console.log(JSON.stringify(result, null, "\t"));
			} finally {
				yield* Effect.promise(() => provider.endAll());
			}
		}),
).pipe(Command.withDescription("Fetch BSR (rank) trend per ASIN, with subcategory names"));

const loadEconomicsCommand = Command.make(
	"loadEconomics",
	{
		wsid: wsidOption,
		stores: Options.text("stores").pipe(Options.withDescription("country/region/marketplaceId/'*'/{merchantId}-{scope}")),
		when: Options.text("when").pipe(Options.withDescription("ISO interval/duration")),
		products: Options.text("products").pipe(Options.optional),
		economics: Options.text("economics").pipe(Options.withDescription("JSON cost inputs {perAsin:{asin:{price,cogs,...}}}"), Options.optional),
	},
	(o) =>
		Effect.gen(function* () {
			const sql = resolveSql(o);
			try {
				const econRaw = Option.getOrUndefined(o.economics);
				const result = yield* Effect.promise(() =>
					loadEconomics({
						stores: o.stores,
						when: o.when,
						products: Option.getOrUndefined(o.products),
						economics: econRaw ? JSON.parse(econRaw) : null,
					}, sql)
				);
				console.log(JSON.stringify(result, null, "\t"));
			} finally {
				yield* Effect.promise(() => provider.endAll());
			}
		}),
).pipe(Command.withDescription("Per-ASIN profitability: ad rollup + (with cost inputs) net margin"));

const inventoryPacingCommand = Command.make(
	"inventoryPacing",
	{
		wsid: wsidOption,
		stores: Options.text("stores").pipe(Options.withDescription("country/region/marketplaceId/'*'/{merchantId}-{scope}")),
		velocityDays: Options.integer("velocity-days").pipe(Options.optional),
		spendWindowDays: Options.integer("spend-window-days").pipe(Options.optional),
		criticalDays: Options.integer("critical-days").pipe(Options.optional),
		lowDays: Options.integer("low-days").pipe(Options.optional),
		overstockDays: Options.integer("overstock-days").pipe(Options.optional),
		minSpendPerDay: Options.float("min-spend-per-day").pipe(Options.optional),
		minVelocity: Options.float("min-velocity").pipe(Options.optional),
	},
	(o) =>
		Effect.gen(function* () {
			const sql = resolveSql(o);
			try {
				const result = yield* Effect.promise(() =>
					loadInventoryPacing({
						stores: o.stores,
						velocityDays: Option.getOrUndefined(o.velocityDays),
						spendWindowDays: Option.getOrUndefined(o.spendWindowDays),
						criticalDays: Option.getOrUndefined(o.criticalDays),
						lowDays: Option.getOrUndefined(o.lowDays),
						overstockDays: Option.getOrUndefined(o.overstockDays),
						minSpendPerDay: Option.getOrUndefined(o.minSpendPerDay),
						minVelocity: Option.getOrUndefined(o.minVelocity),
					}, sql)
				);
				console.log(JSON.stringify(result, null, "\t"));
			} finally {
				yield* Effect.promise(() => provider.endAll());
			}
		}),
).pipe(Command.withDescription("Recommend ad pacing from inventory runway: pause/throttle/hold/ramp per family"));

const root = Command.make("core-mcp").pipe(
	Command.withSubcommands([
		loadAdsCommand,
		loadTrafficCommand,
		loadSqpCommand,
		loadRankCommand,
		loadEconomicsCommand,
		inventoryPacingCommand,
		salesDropDiagnosis,
	]),
);

const cli = Command.run(root, { name: "core-mcp", version: "0.1.0" });

cli(process.argv).pipe(
	Effect.provide(NodeContext.layer),
	NodeRuntime.runMain,
);
