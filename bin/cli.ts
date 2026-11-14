/**
 * CLI frontend (dev / agency / parity). Runs under bun and deno:
 *   bun run bin/cli.ts salesDropDiagnosis --wsid 100000001 --all-stores --format json
 *   deno run -A bin/cli.ts salesDropDiagnosis --wsid 100000001 --stores DE,US
 *
 * Same `(config, sql)` core as the MCP tool. `DATABRILL_CONFIG` maps the
 * required `--wsid` to that workspace's own credential.
 */

import "temporal-polyfill/global";
import packageJson from "../package.json" with { type: "json" };
import { Command, Flag } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Option, Result } from "effect";
import { withEnvConfigProvider, withLogfmtLogger } from "../src/effectCompat.ts";
import { tryOrOperationError } from "../src/effectErrors.ts";
import type { Sql } from "postgres";
import {
	loadConfig,
	resolveWorkspace,
	SQL_FEATURE,
	SQL_WRITE_FEATURE,
	summarizeConfig,
	TFL_INVENTORY_FEATURE,
	workspaceHasFeature,
} from "../src/config.ts";
import { acquireSqlProvider } from "../src/db.ts";
import { describeTable } from "../src/tools/describeTable/load.ts";
import { executeSql } from "../src/tools/executeSql/execute.ts";
import { listTables } from "../src/tools/listTables/load.ts";
import { writeSql } from "../src/tools/writeSql/write.ts";
import { loadAds } from "../src/tools/loadAds/loadAds.ts";
import { loadTraffic } from "../src/tools/loadTraffic/load.ts";
import { loadSqp } from "../src/tools/loadSqp/load.ts";
import { loadRank } from "../src/tools/loadRank/load.ts";
import { loadEconomics } from "../src/tools/loadEconomics/load.ts";
import { loadInventoryPacing } from "../src/tools/inventoryPacing/load.ts";
import { loadProductsTool } from "../src/tools/loadProducts/contract.ts";
import { loadAmazonFbaStockouts } from "../src/tools/loadAmazonFbaStockouts/load.ts";
import { loadTflInventory } from "../src/tools/loadTflInventory/load.ts";
import { load } from "../src/tools/salesDropDiagnosis/load.ts";
import { render } from "../src/tools/salesDropDiagnosis/render.ts";
import { loadStartupEnv, packageRoot } from "../src/startup.ts";

function printJson(result: unknown): Result.Result<void, Error> {
	return tryOrOperationError(() => console.log(JSON.stringify(result, null, "\t")));
}

const program = Effect.gen(function* () {
	yield* loadStartupEnv();
	const loadedConfig = yield* loadConfig(undefined, { rootDir: packageRoot });
	if (loadedConfig === null) {
		return yield* Effect.fail(
			new Error("DATABRILL_CONFIG is required; unscoped POSTGRES_URL mode is not supported"),
		);
	}
	const config = loadedConfig;
	const provider = yield* acquireSqlProvider(config);

	const listWorkspacesCommand = Command.make(
		"listWorkspaces",
		{},
		() => Effect.fromResult(printJson(summarizeConfig(config))),
	).pipe(Command.withDescription("List configured workspaces and merchants without connecting to a database"));

	/** Shared required `--wsid` option. */
	const wsidOption = Flag.String("wsid").pipe(
		Flag.withDescription("Workspace id (required for every data command)"),
	);

	/** Resolve the connection for a command from its explicit `--wsid`. */
	function resolveSql(o: { wsid: string }): Effect.Effect<Sql, Error> {
		return provider.getSqlForArgs({ wsid: o.wsid });
	}

	function resolveFeatureSql(o: { wsid: string }, feature: string): Effect.Effect<Sql, Error> {
		return Effect.gen(function* () {
			const args = { wsid: o.wsid };
			const enabled = workspaceHasFeature(yield* Effect.fromResult(resolveWorkspace(config, args)), feature);
			if (!enabled) {
				return yield* Effect.fail(new Error(`This command requires the workspace feature "${feature}"`));
			}
			return yield* provider.getSqlForArgs(args);
		});
	}

	const loadAdsCommand = Command.make(
		"loadAds",
		{
			wsid: wsidOption,
			stores: Flag.String("stores").pipe(
				Flag.withDescription(
					"country code (US), region (na,eu,fe), marketplaceId, '*', or {merchantId}-{scope}",
				),
			),
			when: Flag.String("when").pipe(
				Flag.withDescription("ISO 8601 interval/duration: 2026-03-30/2026-04-05, P7D, P4W/2026-04-13"),
			),
			groupBy: Flag.String("groupBy").pipe(
				Flag.withDescription("Comma-separated dimensions (asin, family, adType, …)"),
			),
			timeUnit: Flag.String("timeUnit").pipe(Flag.optional),
			products: Flag.String("products").pipe(Flag.optional),
			filter: Flag.String("filter").pipe(Flag.optional),
			derived: Flag.Boolean("derived").pipe(Flag.withDefault(false)),
			nested: Flag.Boolean("nested").pipe(Flag.withDefault(false)),
		},
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveSql(o);
				{
					const result = yield* loadAds({
						stores: o.stores,
						when: o.when,
						groupBy: o.groupBy,
						timeUnit: Option.getOrUndefined(o.timeUnit),
						products: Option.getOrUndefined(o.products),
						filter: Option.getOrUndefined(o.filter),
						derived: o.derived,
						nested: o.nested,
						format: "json",
					}, sql);
					yield* Effect.fromResult(printJson(result));
				}
			}),
	).pipe(
		Command.withDescription(
			"Fetch Amazon advertising metrics aggregated by dimensions (the dbl-metrics-ads loader)",
		),
	);

	const salesDropDiagnosis = Command.make(
		"salesDropDiagnosis",
		{
			wsid: wsidOption,
			stores: Flag.String("stores").pipe(
				Flag.withDescription("Comma-separated store filter: merchantId, country code, or merchantId-site"),
				Flag.optional,
			),
			allStores: Flag.Boolean("all-stores").pipe(
				Flag.withDescription("Include every store with data, not just configured countries"),
				Flag.withDefault(false),
			),
			format: Flag.Literals("format", ["console", "markdown", "json"]).pipe(
				Flag.withDescription("Output format"),
				Flag.withDefault("console" as const),
			),
			recentDays: Flag.Int("recent-days").pipe(Flag.withDefault(7)),
			baselineDays: Flag.Int("baseline-days").pipe(Flag.withDefault(28)),
			dropThreshold: Flag.Finite("drop-threshold").pipe(Flag.withDefault(0.10)),
			inventoryRunwayMax: Flag.Int("inventory-runway-max").pipe(Flag.withDefault(14)),
			skipInventory: Flag.Boolean("skip-inventory").pipe(Flag.withDefault(false)),
		},
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveSql(o);
				const storesRaw = Option.getOrUndefined(o.stores);
				{
					const rows = yield* load({
						stores: storesRaw ? storesRaw.split(",").map((s) => s.trim()).filter(Boolean) : null,
						allStores: o.allStores,
						recentDays: o.recentDays,
						baselineDays: o.baselineDays,
						dropThreshold: o.dropThreshold,
						inventoryRunwayMax: o.inventoryRunwayMax,
						skipInventory: o.skipInventory,
					}, sql);
					yield* Effect.fromResult(render(rows, o.format));
				}
			}),
	).pipe(
		Command.withDescription("Diagnose why a store's sales dropped: rank traffic/conversion/price causes + signals"),
	);

	const loadTrafficCommand = Command.make(
		"loadTraffic",
		{
			wsid: wsidOption,
			stores: Flag.String("stores").pipe(
				Flag.withDescription("country code, region, marketplaceId, '*', or {merchantId}-{scope}"),
			),
			when: Flag.String("when").pipe(
				Flag.withDescription("ISO interval/duration: P7D, 2026-03-30/2026-04-05"),
			),
			groupBy: Flag.String("groupBy").pipe(Flag.withDescription("asin (default) | family"), Flag.optional),
			timeUnit: Flag.String("timeUnit").pipe(
				Flag.withDescription("WEEK (default) | DAY | MONTH"),
				Flag.optional,
			),
			products: Flag.String("products").pipe(Flag.optional),
		},
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveSql(o);
				{
					const result = yield* loadTraffic({
						stores: o.stores,
						when: o.when,
						groupBy: Option.getOrUndefined(o.groupBy),
						timeUnit: Option.getOrUndefined(o.timeUnit),
						products: Option.getOrUndefined(o.products),
					}, sql);
					yield* Effect.fromResult(printJson(result));
				}
			}),
	).pipe(Command.withDescription("Fetch Sales & Traffic metrics (sessions/units/sales/CR) per ASIN or family"));

	const loadSqpCommand = Command.make(
		"loadSqp",
		{
			wsid: wsidOption,
			stores: Flag.String("stores").pipe(
				Flag.withDescription("country/region/marketplaceId/'*'/{merchantId}-{scope}"),
			),
			when: Flag.String("when").pipe(Flag.withDescription("ISO interval/duration")),
			products: Flag.String("products").pipe(Flag.optional),
			timeUnit: Flag.String("timeUnit").pipe(
				Flag.withDescription("WEEK (default) | MONTH"),
				Flag.optional,
			),
			keywordLimit: Flag.Int("keywordLimit").pipe(
				Flag.withDescription("Top-N search queries by market impressions, 1-200 (default 25)"),
				Flag.optional,
			),
		},
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveSql(o);
				{
					const result = yield* loadSqp({
						stores: o.stores,
						when: o.when,
						products: Option.getOrUndefined(o.products),
						timeUnit: Option.getOrUndefined(o.timeUnit),
						keywordLimit: Option.getOrUndefined(o.keywordLimit),
					}, sql);
					yield* Effect.fromResult(printJson(result));
				}
			}),
	).pipe(Command.withDescription("Fetch Search Query Performance: our-vs-market shares + top keywords"));

	const loadRankCommand = Command.make(
		"loadRank",
		{
			wsid: wsidOption,
			stores: Flag.String("stores").pipe(
				Flag.withDescription("country/region/marketplaceId/'*'/{merchantId}-{scope}"),
			),
			when: Flag.String("when").pipe(Flag.withDescription("ISO interval/duration")),
			products: Flag.String("products").pipe(Flag.optional),
		},
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveSql(o);
				{
					const result = yield* loadRank({
						stores: o.stores,
						when: o.when,
						products: Option.getOrUndefined(o.products),
					}, sql);
					yield* Effect.fromResult(printJson(result));
				}
			}),
	).pipe(Command.withDescription("Fetch BSR (rank) trend per ASIN, with subcategory names"));

	const loadEconomicsCommand = Command.make(
		"loadEconomics",
		{
			wsid: wsidOption,
			stores: Flag.String("stores").pipe(
				Flag.withDescription("country/region/marketplaceId/'*'/{merchantId}-{scope}"),
			),
			when: Flag.String("when").pipe(Flag.withDescription("ISO interval/duration")),
			products: Flag.String("products").pipe(Flag.optional),
			economics: Flag.String("economics").pipe(
				Flag.withDescription("JSON cost inputs {perAsin:{asin:{price,cogs,...}}}"),
				Flag.optional,
			),
		},
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveSql(o);
				{
					const econRaw = Option.getOrUndefined(o.economics);
					const result = yield* loadEconomics({
						stores: o.stores,
						when: o.when,
						products: Option.getOrUndefined(o.products),
						economics: econRaw
							? (yield* Effect.fromResult(tryOrOperationError(() => JSON.parse(econRaw))))
							: null,
					}, sql);
					yield* Effect.fromResult(printJson(result));
				}
			}),
	).pipe(Command.withDescription("Per-ASIN profitability: ad rollup + (with cost inputs) net margin"));

	const inventoryPacingCommand = Command.make(
		"inventoryPacing",
		{
			wsid: wsidOption,
			stores: Flag.String("stores").pipe(
				Flag.withDescription("country/region/marketplaceId/'*'/{merchantId}-{scope}"),
			),
			velocityDays: Flag.Int("velocity-days").pipe(Flag.optional),
			spendWindowDays: Flag.Int("spend-window-days").pipe(Flag.optional),
			criticalDays: Flag.Int("critical-days").pipe(Flag.optional),
			lowDays: Flag.Int("low-days").pipe(Flag.optional),
			overstockDays: Flag.Int("overstock-days").pipe(Flag.optional),
			minSpendPerDay: Flag.Finite("min-spend-per-day").pipe(Flag.optional),
			minVelocity: Flag.Finite("min-velocity").pipe(Flag.optional),
		},
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveSql(o);
				{
					const result = yield* loadInventoryPacing({
						stores: o.stores,
						velocityDays: Option.getOrUndefined(o.velocityDays),
						spendWindowDays: Option.getOrUndefined(o.spendWindowDays),
						criticalDays: Option.getOrUndefined(o.criticalDays),
						lowDays: Option.getOrUndefined(o.lowDays),
						overstockDays: Option.getOrUndefined(o.overstockDays),
						minSpendPerDay: Option.getOrUndefined(o.minSpendPerDay),
						minVelocity: Option.getOrUndefined(o.minVelocity),
					}, sql);
					yield* Effect.fromResult(printJson(result));
				}
			}),
	).pipe(Command.withDescription("Recommend ad pacing from inventory runway: pause/throttle/hold/ramp per family"));

	const loadTflInventoryCommand = Command.make(
		"loadTflInventory",
		{
			wsid: wsidOption,
			products: Flag.String("products").pipe(
				Flag.withDescription("Comma-separated exact product ids, product names, or SKUs"),
				Flag.optional,
			),
			warehouses: Flag.String("warehouses").pipe(
				Flag.withDescription("Comma-separated exact warehouse ids or names"),
				Flag.optional,
			),
			asOf: Flag.String("as-of").pipe(
				Flag.withDescription("Latest daily snapshot on or before YYYY-MM-DD"),
				Flag.optional,
			),
			maxAvailable: Flag.Finite("max-available").pipe(Flag.optional),
			limit: Flag.Int("limit").pipe(Flag.optional),
		},
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveFeatureSql(o, TFL_INVENTORY_FEATURE);
				{
					const result = yield* loadTflInventory({
						products: Option.getOrUndefined(o.products),
						warehouses: Option.getOrUndefined(o.warehouses),
						asOf: Option.getOrUndefined(o.asOf),
						maxAvailable: Option.getOrUndefined(o.maxAvailable),
						limit: Option.getOrUndefined(o.limit),
					}, sql);
					yield* Effect.fromResult(printJson(result));
				}
			}),
	).pipe(Command.withDescription("Fetch the latest The Fulfillment Lab product-by-warehouse inventory snapshot"));

	const loadAmazonFbaStockoutsCommand = Command.make(
		"loadAmazonFbaStockouts",
		{
			wsid: wsidOption,
			stores: Flag.String("stores").pipe(
				Flag.withDescription("Country, region (na, eu, fe), marketplaceId, '*', or {merchantId}-{scope}"),
			),
			when: Flag.String("when").pipe(
				Flag.withDescription(
					"ISO interval, or a duration ending on the latest local today of the selected stores' marketplaces " +
						"(default: the last 90 days)",
				),
				Flag.optional,
			),
			products: Flag.String("products").pipe(
				Flag.withDescription(
					"Child or parent ASINs, family names, FNSKUs or seller SKUs; every token is also matched as an " +
						"FNSKU and as a seller SKU",
				),
				Flag.optional,
			),
			limit: Flag.Int("limit").pipe(
				Flag.withDescription("Maximum episodes, 1-1000 (default 250)"),
				Flag.optional,
			),
		},
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveSql(o);
				const result = yield* loadAmazonFbaStockouts({
					stores: o.stores,
					when: Option.getOrUndefined(o.when),
					products: Option.getOrUndefined(o.products),
					limit: Option.getOrUndefined(o.limit),
				}, sql);
				yield* Effect.fromResult(printJson(result));
			}),
	).pipe(Command.withDescription("Read FBA stockout episodes per merchant, marketplace and FNSKU"));

	const loadProductsCommand = Command.make(
		"loadProducts",
		{
			wsid: wsidOption,
			level: Flag.Literals("level", ["family", "parentAsin", "asin", "sku"]).pipe(Flag.withDefault("family")),
			stores: Flag.String("stores").pipe(
				Flag.withDescription("Countries, regions, marketplace IDs or merchantId-scope; default all stores"),
				Flag.optional,
			),
			products: Flag.String("products").pipe(
				Flag.withDescription("Families, parent ASINs or child ASINs"),
				Flag.optional,
			),
			search: Flag.String("search").pipe(
				Flag.withDescription("Literal substring in title or family"),
				Flag.optional,
			),
			columns: Flag.String("columns").pipe(
				Flag.withDescription("Comma-separated columns; see meta.columnsAvailable"),
				Flag.optional,
			),
			includeUnassigned: Flag.Boolean("include-unassigned").pipe(
				Flag.withDescription("Use --no-include-unassigned to exclude products without a family"),
				Flag.withDefault(true),
			),
			limit: Flag.Int("limit").pipe(Flag.optional),
			offset: Flag.Int("offset").pipe(Flag.optional),
		},
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveSql(o);
				const result = yield* loadProductsTool.run({
					level: o.level,
					stores: Option.getOrUndefined(o.stores),
					products: Option.getOrUndefined(o.products),
					search: Option.getOrUndefined(o.search),
					columns: Option.getOrUndefined(o.columns),
					includeUnassigned: o.includeUnassigned,
					limit: Option.getOrUndefined(o.limit),
					offset: Option.getOrUndefined(o.offset),
				}, sql);
				yield* Effect.fromResult(printJson(result));
			}),
	).pipe(Command.withDescription("Discover product families, parent ASINs, ASINs and seller SKUs"));

	const listTablesCommand = Command.make(
		"listTables",
		{ wsid: wsidOption },
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveFeatureSql(o, SQL_FEATURE);
				{
					const result = yield* listTables(sql);
					yield* Effect.fromResult(printJson(result));
				}
			}),
	).pipe(Command.withDescription("List the tables and views in the workspace's own schema"));

	const describeTableCommand = Command.make(
		"describeTable",
		{
			wsid: wsidOption,
			table: Flag.String("table").pipe(
				Flag.withDescription("Bare table name (no schema qualifier) in the workspace's own schema"),
			),
		},
		(o) =>
			Effect.gen(function* () {
				const sql = yield* resolveFeatureSql(o, SQL_FEATURE);
				{
					const result = yield* describeTable({ table: o.table }, sql);
					yield* Effect.fromResult(printJson(result));
				}
			}),
	).pipe(Command.withDescription("Describe one table's columns, data types and nullability"));

	const executeSqlCommand = Command.make(
		"executeSql",
		{
			wsid: wsidOption,
			sql: Flag.String("sql").pipe(Flag.withDescription("Exactly one read-only SQL statement")),
			limit: Flag.Int("limit").pipe(
				Flag.withDescription("Maximum rows to return; a request above the maximum is rejected"),
				Flag.optional,
			),
		},
		(o) =>
			Effect.gen(function* () {
				const client = yield* resolveFeatureSql(o, SQL_FEATURE);
				{
					const result = yield* executeSql({ sql: o.sql, limit: Option.getOrUndefined(o.limit) }, client);
					yield* Effect.fromResult(printJson(result));
				}
			}),
	).pipe(Command.withDescription("Run one read-only SQL statement in a read-only transaction with caps"));

	const writeSqlCommand = Command.make(
		"writeSql",
		{
			wsid: wsidOption,
			sql: Flag.String("sql").pipe(Flag.withDescription("Exactly one write statement")),
		},
		(o) =>
			Effect.gen(function* () {
				const client = yield* resolveFeatureSql(o, SQL_WRITE_FEATURE);
				{
					const result = yield* writeSql({ sql: o.sql }, client);
					yield* Effect.fromResult(printJson(result));
				}
			}),
	).pipe(Command.withDescription("Run one write statement; the database role's grants decide what it may touch"));

	const root = Command.make("core-mcp").pipe(
		Command.withSubcommands([
			listWorkspacesCommand,
			loadAdsCommand,
			loadTrafficCommand,
			loadSqpCommand,
			loadRankCommand,
			loadEconomicsCommand,
			loadTflInventoryCommand,
			loadAmazonFbaStockoutsCommand,
			loadProductsCommand,
			inventoryPacingCommand,
			salesDropDiagnosis,
			listTablesCommand,
			describeTableCommand,
			executeSqlCommand,
			writeSqlCommand,
		]),
	);

	const cli = Command.runWith(root, { version: packageJson.version });

	return yield* cli(process.argv.slice(2));
}).pipe(Effect.scoped);

program.pipe(
	Effect.provide(NodeServices.layer),
	withEnvConfigProvider,
	withLogfmtLogger,
	NodeRuntime.runMain,
);
