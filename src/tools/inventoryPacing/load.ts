/**
 * inventoryPacing — joins each family's inventory runway (lowInventory) with its
 * current ad spend (familyWindow) and maps the runway band to a pacing action.
 * The decide/decideBand logic is copied verbatim from the agency report; only
 * identity (resolved stores) and the connection (injected) changed.
 */

import type postgres from "postgres";
import { sinceDaysAgo } from "../../clientData.ts";
import { resolveStores } from "../loadAds/loadAds.ts";
import { loadLowInventory } from "./lowInventory.ts";
import { loadFamilyWindow } from "./familyWindow.ts";
import type {
	LoadInventoryPacingParams,
	LoadInventoryPacingResult,
	PacingAction,
	PacingConfig,
	PacingRow,
} from "./types.ts";

interface FamilyInv {
	merchantId: string;
	site: string;
	family: string;
	available: number;
	inbound: number;
	units7d: number;
	worstAsin: string | null;
	worstAsinLabel: string | null;
	worstAsinRunway: number | null;
}

function decide(
	row: {
		runwayDays: number | null;
		runwayWithInboundDays: number | null;
		velocityPerDay: number;
		adSpendPerDay: number;
		inbound: number;
		tacos: number | null;
		worstAsin: string | null;
		worstAsinLabel: string | null;
		worstAsinRunway: number | null;
	},
	c: PacingConfig,
): { action: PacingAction; severity: PacingRow["severity"]; rationale: string } {
	const base = decideBand(row, c);
	if (
		(base.action === "ramp" || base.action === "hold") &&
		row.worstAsinRunway != null && row.worstAsinRunway <= c.criticalDays
	) {
		return {
			...base,
			severity: base.severity === "low" ? "medium" : base.severity,
			rationale: `${base.rationale} Caveat: variant ${row.worstAsinLabel} (${row.worstAsin}) is at ${
				Math.round(row.worstAsinRunway)
			}d — restock it or exclude it from targeting; don't push spend onto an out-of-stock child.`,
		};
	}
	return base;
}

function decideBand(
	row: {
		runwayDays: number | null;
		runwayWithInboundDays: number | null;
		velocityPerDay: number;
		adSpendPerDay: number;
		inbound: number;
		tacos: number | null;
	},
	c: PacingConfig,
): { action: PacingAction; severity: PacingRow["severity"]; rationale: string } {
	const { runwayDays, runwayWithInboundDays, velocityPerDay, adSpendPerDay, inbound } = row;
	const spendActive = adSpendPerDay >= c.minSpendPerDay;
	const restockRelieves = runwayWithInboundDays != null && runwayWithInboundDays > c.lowDays && inbound > 0;
	const inboundNote = inbound > 0
		? ` Inbound ${inbound} extends to ~${runwayWithInboundDays ?? "n/a"}d.`
		: " No inbound on the way.";

	if (velocityPerDay < c.minVelocity || runwayDays == null) {
		return {
			action: "hold",
			severity: "low",
			rationale: `Sells ${
				velocityPerDay.toFixed(2)
			} units/day — too slow to estimate a meaningful runway; pacing not inventory-driven here.`,
		};
	}

	if (runwayDays <= c.criticalDays) {
		if (spendActive && !restockRelieves) {
			return {
				action: "pause",
				severity: "high",
				rationale: `Runway ${Math.round(runwayDays)}d (≤ ${c.criticalDays}d critical) at ${
					velocityPerDay.toFixed(1)
				} units/day; ad spend ${
					adSpendPerDay.toFixed(2)
				}/day is paying to accelerate an imminent stockout — pause or cut hard.${inboundNote}`,
			};
		}
		if (spendActive && restockRelieves) {
			return {
				action: "throttle",
				severity: "medium",
				rationale: `Runway ${Math.round(runwayDays)}d is critical but restock is inbound (covers to ~${
					runwayWithInboundDays ?? "n/a"
				}d) — throttle spend to bridge the gap rather than pause.`,
			};
		}
		return {
			action: "hold",
			severity: "low",
			rationale: `Runway ${Math.round(runwayDays)}d is critical but ad spend is ${
				adSpendPerDay.toFixed(2)
			}/day (little to cut).${inboundNote}`,
		};
	}

	if (runwayDays <= c.lowDays) {
		if (spendActive && !restockRelieves) {
			return {
				action: "throttle",
				severity: "medium",
				rationale: `Runway ${Math.round(runwayDays)}d (≤ ${c.lowDays}d low); reduce spend (now ${
					adSpendPerDay.toFixed(2)
				}/day) to stretch stock until restock.${inboundNote}`,
			};
		}
		return {
			action: "hold",
			severity: "low",
			rationale: `Runway ${Math.round(runwayDays)}d is low but ${
				restockRelieves ? "inbound restock relieves it" : "there is little ad spend to cut"
			}.${inboundNote}`,
		};
	}

	if (runwayDays >= c.overstockDays) {
		return {
			action: "ramp",
			severity: runwayDays >= c.overstockDays * 2 ? "high" : "medium",
			rationale: `Runway ${
				Math.round(runwayDays)
			}d (≥ ${c.overstockDays}d overstock; long-term storage-fee risk) at ${
				velocityPerDay.toFixed(1)
			} units/day; ad spend is ${adSpendPerDay.toFixed(2)}/day${
				row.tacos != null ? `, TACoS ${(row.tacos * 100).toFixed(1)}%` : ""
			} — push spend/deals to sell down.`,
		};
	}

	return {
		action: "hold",
		severity: "low",
		rationale: `Runway ${Math.round(runwayDays)}d is healthy; maintain current pacing.`,
	};
}

const actionRank: Record<PacingAction, number> = { pause: 0, throttle: 1, ramp: 2, hold: 3 };

function resolveConfig(p: LoadInventoryPacingParams): PacingConfig {
	return {
		velocityDays: p.velocityDays ?? 7,
		spendWindowDays: p.spendWindowDays ?? 7,
		criticalDays: p.criticalDays ?? 7,
		lowDays: p.lowDays ?? 21,
		overstockDays: p.overstockDays ?? 90,
		minSpendPerDay: p.minSpendPerDay ?? 1,
		minVelocity: p.minVelocity ?? 0.2,
	};
}

export async function loadInventoryPacing(
	params: LoadInventoryPacingParams,
	sql: postgres.Sql,
): Promise<LoadInventoryPacingResult> {
	if (!params.stores) throw new Error("stores is required");
	const config = resolveConfig(params);

	const stores = await resolveStores(params.stores, sql);
	const invRows = await loadLowInventory(sql, stores, config.velocityDays);

	// Fold ASIN rows into family-level inventory.
	const fams = new Map<string, FamilyInv>();
	for (const r of invRows) {
		const site = r.country.toUpperCase();
		const key = `${r.merchantId}|||${site}|||${r.family}`;
		let f = fams.get(key);
		if (!f) {
			f = {
				merchantId: r.merchantId,
				site,
				family: r.family,
				available: 0,
				inbound: 0,
				units7d: 0,
				worstAsin: null,
				worstAsinLabel: null,
				worstAsinRunway: null,
			};
			fams.set(key, f);
		}
		f.available += r.inventoryFba + r.inventoryFbm;
		f.inbound += r.inbound;
		f.units7d += r.units7d;
		if (r.runway != null && (f.worstAsinRunway == null || r.runway < f.worstAsinRunway)) {
			f.worstAsinRunway = r.runway;
			f.worstAsin = r.asin;
			f.worstAsinLabel = r.label;
		}
	}

	const merchantIds = [...new Set(stores.map((s) => s.merchantId))];
	const since = sinceDaysAgo(config.spendWindowDays);
	const familyWindow = await loadFamilyWindow(sql, merchantIds, since);
	const adByKey = new Map<string, { spend: number; adSales: number; tacos: number | null }>();
	for (const fa of familyWindow) {
		adByKey.set(`${fa.merchantId}|||${fa.site.toUpperCase()}|||${fa.family}`, {
			spend: fa.spend,
			adSales: fa.adSales,
			tacos: fa.tacos,
		});
	}

	const out: PacingRow[] = [];
	for (const [key, f] of fams) {
		const velocityPerDay = f.units7d / Math.max(1, config.velocityDays);
		const runwayDays = velocityPerDay > 0 ? f.available / velocityPerDay : null;
		const runwayWithInboundDays = velocityPerDay > 0 ? (f.available + f.inbound) / velocityPerDay : null;

		const ad = adByKey.get(key);
		const adSpendPerDay = (ad?.spend ?? 0) / Math.max(1, config.spendWindowDays);
		const adSalesPerDay = (ad?.adSales ?? 0) / Math.max(1, config.spendWindowDays);
		const tacos = ad?.tacos ?? null;

		const { action, severity, rationale } = decide(
			{
				runwayDays,
				runwayWithInboundDays,
				velocityPerDay,
				adSpendPerDay,
				inbound: f.inbound,
				tacos,
				worstAsin: f.worstAsin,
				worstAsinLabel: f.worstAsinLabel,
				worstAsinRunway: f.worstAsinRunway,
			},
			config,
		);

		out.push({
			merchantId: f.merchantId,
			site: f.site,
			family: f.family,
			available: f.available,
			inbound: f.inbound,
			velocityPerDay,
			runwayDays,
			runwayWithInboundDays,
			worstAsin: f.worstAsin,
			worstAsinLabel: f.worstAsinLabel,
			worstAsinRunway: f.worstAsinRunway,
			adSpendPerDay,
			adSalesPerDay,
			tacos,
			action,
			severity,
			rationale,
		});
	}

	out.sort((a, b) =>
		actionRank[a.action] - actionRank[b.action] ||
		(a.runwayDays ?? Infinity) - (b.runwayDays ?? Infinity)
	);

	return {
		meta: { stores: [...new Set(stores.map((s) => s.countryCode))], familyCount: out.length, config },
		data: out,
	};
}
