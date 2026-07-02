/**
 * Aggregate tool contract — the registry every frontend imports. Adding a tool
 * means adding it here; `registerTools`, the CLI, and the hosted app pick it up.
 */

import type { Sql } from "postgres";
import { inventoryPacingTool } from "./tools/inventoryPacing/contract.ts";
import { loadAdsTool } from "./tools/loadAds/contract.ts";
import { loadEconomicsTool } from "./tools/loadEconomics/contract.ts";
import { loadRankTool } from "./tools/loadRank/contract.ts";
import { loadSqpTool } from "./tools/loadSqp/contract.ts";
import { loadTrafficTool } from "./tools/loadTraffic/contract.ts";
import { salesDropDiagnosisTool } from "./tools/salesDropDiagnosis/contract.ts";

export interface McpTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly run: (args: Record<string, unknown>, sql: Sql) => Promise<unknown>;
}

// Metric-fetch loaders first (the primary surface), then question tools.
export const tools: readonly McpTool[] = [
	loadAdsTool,
	loadTrafficTool,
	loadSqpTool,
	loadRankTool,
	loadEconomicsTool,
	inventoryPacingTool,
	salesDropDiagnosisTool,
];
