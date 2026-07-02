/**
 * Sales-drop diagnosis — rendering. Pure functions, no DB access. Verbatim from
 * the agency repo `lib/reports/salesDropDiagnosis/render.ts`.
 */

import type { DropCause, OutputFormat, StoreDiagnosis } from "./types.ts";

function pct(v: number | null, signed = true): string {
	if (v == null) return "n/a";
	const s = (v * 100).toFixed(0);
	return signed && v >= 0 ? `+${s}%` : `${s}%`;
}

function causeLine(c: DropCause): string {
	const effect = c.approxPctEffect == null ? "n/a" : pct(c.approxPctEffect);
	const share = c.share == null ? "" : ` · ${(c.share * 100).toFixed(0)}% of the change`;
	return `${c.label}: ${c.direction} (${effect}${share}) — ${c.evidence}`;
}

function renderStoreText(d: StoreDiagnosis): string[] {
	const lines: string[] = [];
	const head = d.isDrop ? "DROP" : d.deltaPct != null && d.deltaPct > 0.1 ? "up" : "flat";
	lines.push(
		`■ ${d.store} — sales/day ${
			pct(d.deltaPct)
		} (${head}); ${d.recentWindow.dateFirst}→${d.recentWindow.dateLast} vs ${d.baselineWindow.dateFirst}→${d.baselineWindow.dateLast}`,
	);
	lines.push(
		`  baseline ${
			d.baselineWindow.salesPerDay.toLocaleString("en-US", { maximumFractionDigits: 0 })
		}/day → recent ${
			d.recentWindow.salesPerDay.toLocaleString("en-US", { maximumFractionDigits: 0 })
		}/day (${d.currency})`,
	);
	lines.push("  Ranked causes (funnel decomposition):");
	for (const c of d.causes) lines.push(`    • ${causeLine(c)}`);
	if (d.signals.length > 0) {
		lines.push("  Contributing signals:");
		for (const s of d.signals) lines.push(`    • [${s.severity}] ${s.label}: ${s.evidence}`);
	}
	if (d.inventoryFlags.length > 0) {
		lines.push("  Low-runway ASINs:");
		for (const f of d.inventoryFlags.slice(0, 8)) {
			lines.push(
				`    • ${f.label} (${f.asin}): ${f.runway ?? "n/a"}d runway (${
					f.runwayWithInbound ?? "n/a"
				}d w/ inbound), ${f.inventoryAvailable} available, ${f.inbound} inbound`,
			);
		}
	}
	for (const n of d.notes) lines.push(`  note: ${n}`);
	return lines;
}

export function render(rows: StoreDiagnosis[], format: OutputFormat): void {
	if (format === "json") {
		console.log(JSON.stringify(rows, null, "\t"));
		return;
	}

	if (rows.length === 0) {
		console.log("No in-scope stores with enough history to diagnose.");
		return;
	}

	if (format === "markdown") {
		const out: string[] = ["# Sales-drop diagnosis", ""];
		for (const d of rows) {
			out.push(
				`## ${d.store} — ${pct(d.deltaPct)} sales/day ${d.isDrop ? "📉" : ""}`,
				"",
				`Recent ${d.recentWindow.dateFirst}→${d.recentWindow.dateLast} vs baseline ${d.baselineWindow.dateFirst}→${d.baselineWindow.dateLast}. ` +
					`Sales/day ${d.baselineWindow.salesPerDay.toFixed(0)} → ${
						d.recentWindow.salesPerDay.toFixed(0)
					} ${d.currency}.`,
				"",
				"**Ranked causes (funnel decomposition):**",
				"",
			);
			for (const c of d.causes) out.push(`- ${causeLine(c)}`);
			if (d.signals.length > 0) {
				out.push("", "**Contributing signals:**", "");
				for (const s of d.signals) out.push(`- [${s.severity}] ${s.label}: ${s.evidence}`);
			}
			if (d.inventoryFlags.length > 0) {
				out.push("", "**Low-runway ASINs:**", "");
				for (const f of d.inventoryFlags.slice(0, 8)) {
					out.push(
						`- ${f.label} (${f.asin}): ${
							f.runway ?? "n/a"
						}d runway, ${f.inventoryAvailable} available, ${f.inbound} inbound`,
					);
				}
			}
			for (const n of d.notes) out.push("", `_${n}_`);
			out.push("");
		}
		console.log(out.join("\n"));
		return;
	}

	// console
	const out: string[] = [];
	for (const d of rows) {
		out.push(...renderStoreText(d), "");
	}
	console.log(out.join("\n"));
}
