import type { AdMetrics } from "./AdMetrics.ts";

/**
 * Sum ad metrics across rows.
 *
 * This is the zero-dependency, ad-prefixed counterpart of
 * `databrill-client-code/lib/sumAdStats.ts`. mcp-local cannot import the agency
 * package's ICOUSS types or their dependency graph.
 */
export function summarizeAdMetrics(rows: readonly AdMetrics[]): AdMetrics {
	return {
		adImpressions: rows.reduce((sum, row) => sum + row.adImpressions, 0),
		adClicks: rows.reduce((sum, row) => sum + row.adClicks, 0),
		adOrders: rows.reduce((sum, row) => sum + row.adOrders, 0),
		adUnits: rows.reduce((sum, row) => sum + row.adUnits, 0),
		adSpend: rows.reduce((sum, row) => sum + row.adSpend, 0),
		adSales: rows.reduce((sum, row) => sum + row.adSales, 0),
	};
}
