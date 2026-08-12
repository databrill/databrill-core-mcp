/**
 * Aggregate tool contract — the registry every frontend imports. Adding a tool
 * means adding it here; `registerTools`, the CLI, and the hosted app pick it up.
 */

import type { Sql } from "postgres";
import { describeTableTool } from "./tools/describeTable/contract.ts";
import { executeSqlTool } from "./tools/executeSql/contract.ts";
import { inventoryPacingTool } from "./tools/inventoryPacing/contract.ts";
import { listTablesTool } from "./tools/listTables/contract.ts";
import { loadAdsTool } from "./tools/loadAds/contract.ts";
import { loadEconomicsTool } from "./tools/loadEconomics/contract.ts";
import { loadRankTool } from "./tools/loadRank/contract.ts";
import { loadSqpTool } from "./tools/loadSqp/contract.ts";
import { loadTrafficTool } from "./tools/loadTraffic/contract.ts";
import { loadTflInventoryTool } from "./tools/loadTflInventory/contract.ts";
import { salesDropDiagnosisTool } from "./tools/salesDropDiagnosis/contract.ts";
import { writeSqlTool } from "./tools/writeSql/contract.ts";
import type { McpToolHooks } from "./toolHooks.ts";

export interface McpTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	/**
	 * `hooks` is optional and most tools ignore it; a tool that opens a transaction
	 * runs `hooks.assertIdentity` as that transaction's first statement.
	 */
	readonly run: (args: Record<string, unknown>, sql: Sql, hooks?: McpToolHooks) => Promise<unknown>;
	/** Optional workspace feature flag required before this tool is listed or callable. */
	readonly feature?: string;
	/** Which kind of connection this tool must be handed. Absent means `"read"`. */
	readonly access?: McpToolAccess;
}

/**
 * Whether a tool reads or writes. DECLARED by the tool, never inferred from its
 * name, so a frontend can route each call to a different connection without
 * matching on names — the one seam where read/write routing is enforceable.
 * Absent means `"read"`.
 */
export type McpToolAccess = "read" | "write";

// Metric-fetch loaders first (the primary surface), then question tools, then
// the general SQL surface.
export const tools: readonly McpTool[] = [
	loadAdsTool,
	loadTrafficTool,
	loadSqpTool,
	loadRankTool,
	loadEconomicsTool,
	loadTflInventoryTool,
	inventoryPacingTool,
	salesDropDiagnosisTool,
	listTablesTool,
	describeTableTool,
	executeSqlTool,
	writeSqlTool,
];
