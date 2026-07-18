/**
 * Parity test — salesDropDiagnosis port vs the agency reference report.
 *
 * Proves the strip-down (dropping $-aliases / extern / digest `_shared`, swapping
 * client.json identity for DB discovery, injecting `sql`) did not change the math.
 *
 * Method: run BOTH against the SAME client DB.
 *   • reference: `deno task reports salesDropDiagnosis` in the agency repo
 *     (connects via pg_service `w{wsid}`).
 *   • port:      this repo's `load()` in-process, POSTGRES_URL derived from the
 *     agency repo's pg_service.conf + .env.local password (same physical DB).
 * Both run with `--all-stores --skip-inventory`, so the store set and inventory
 * handling are identical and only the sales-decomposition math is compared.
 *
 * Run:  bun run test/parity_salesDropDiagnosis.ts
 * Env:  AGENCY_REPO (default ~/src/agency-repo), CLIENT (default exampleclient)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Effect } from "effect";
import { getSql } from "../src/db.ts";
import { load } from "../src/tools/salesDropDiagnosis/load.ts";
import type { StoreDiagnosis } from "../src/tools/salesDropDiagnosis/types.ts";

const AGENCY_REPO = process.env.AGENCY_REPO ?? `${homedir()}/src/agency-repo`;
const CLIENT = process.env.CLIENT ?? "exampleclient";
const EPS = 1e-9;

function fail(msg: string): never {
	console.error(`\n✖ ${msg}`);
	process.exit(1);
}

/** Build a POSTGRES_URL for the client from the agency repo's pg_service.conf + .env.local. */
function derivePostgresUrl(): string {
	const client = JSON.parse(readFileSync(`${AGENCY_REPO}/clients/${CLIENT}/client.json`, "utf8"));
	const service = `w${client.wsid}`;
	const envVar = `W${client.wsid}_DB_PASSWORD`; // same derivation getDb uses

	const conf = readFileSync(`${AGENCY_REPO}/pg_service.conf`, "utf8");
	const section = conf.split(/^\[/m).find((s) => s.startsWith(`${service}]`));
	if (!section) fail(`service [${service}] not found in ${AGENCY_REPO}/pg_service.conf`);
	const kv: Record<string, string> = {};
	for (const line of section.split("\n")) {
		const m = line.match(/^([a-z_]+)=(.*)$/);
		if (m) kv[m[1]] = m[2].trim();
	}

	const envFile = readFileSync(`${AGENCY_REPO}/.env.local`, "utf8");
	const pwLine = envFile.split("\n").find((l) => l.startsWith(`${envVar}=`));
	if (!pwLine) fail(`${envVar} not found in ${AGENCY_REPO}/.env.local`);
	const password = pwLine.slice(envVar.length + 1).replace(/^"|"$/g, "");

	// Mirror what getDb (pg_service) puts on the connection: sslmode + the startup
	// `options` (e.g. --search_path=w… for schema-in-shared-instance clients).
	// Without the search_path the connection resolves to the wrong
	// schema and every table read fails.
	const params: string[] = [];
	if (kv.sslmode) params.push(`sslmode=${kv.sslmode}`);
	const searchPath = kv.options?.match(/search_path=([^\s]+)/)?.[1];
	if (searchPath) params.push(`options=${encodeURIComponent(`-c search_path=${searchPath}`)}`);
	const query = params.length ? `?${params.join("&")}` : "";
	return `postgresql://${encodeURIComponent(kv.user)}:${
		encodeURIComponent(password)
	}@${kv.host}:${kv.port}/${kv.dbname}${query}`;
}

function runReference(): StoreDiagnosis[] {
	const stdout = execFileSync(
		"deno",
		[
			"task",
			"reports",
			"salesDropDiagnosis",
			"--client",
			CLIENT,
			"--all-stores",
			"--skip-inventory",
			"--format",
			"json",
		],
		{ cwd: AGENCY_REPO, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
	);
	return JSON.parse(stdout) as StoreDiagnosis[];
}

async function runPort(url: string): Promise<StoreDiagnosis[]> {
	const sql = getSql(url);
	try {
		return await Effect.runPromise(
			load({
				stores: null,
				allStores: true,
				recentDays: 7,
				baselineDays: 28,
				dropThreshold: 0.10,
				inventoryRunwayMax: 14,
				skipInventory: true,
			}, sql),
		);
	} finally {
		await sql.end();
	}
}

function numClose(a: number, b: number): boolean {
	const d = Math.abs(a - b);
	return d <= EPS || d <= EPS * Math.max(Math.abs(a), Math.abs(b));
}

/** Deep structural diff; pushes a human path for each mismatch. */
function diff(a: unknown, b: unknown, path: string, out: string[]): void {
	if (typeof a === "number" && typeof b === "number") {
		if (!numClose(a, b)) out.push(`${path}: ${a} ≠ ${b}`);
		return;
	}
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
		if (a !== b) out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
		return;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		const aa = a as unknown[], bb = b as unknown[];
		if (!Array.isArray(a) || !Array.isArray(b)) return void out.push(`${path}: array/non-array mismatch`);
		if (aa.length !== bb.length) out.push(`${path}.length: ${aa.length} ≠ ${bb.length}`);
		for (let i = 0; i < Math.min(aa.length, bb.length); i++) diff(aa[i], bb[i], `${path}[${i}]`, out);
		return;
	}
	const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
	for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) diff(ao[k], bo[k], `${path}.${k}`, out);
}

// GB and UK are the same marketplace; the agency constants label it "UK", the
// client DB / vendored constants label it "GB". Collapse for matching, and the
// site/store label fields are excluded from the math comparison below.
const siteKey = (s: string) => (s.toUpperCase() === "UK" ? "GB" : s.toUpperCase());
const key = (d: StoreDiagnosis) => `${d.merchantId}-${siteKey(d.site)}`;

async function main() {
	console.log(`Parity: salesDropDiagnosis — client=${CLIENT}, agency=${AGENCY_REPO}`);
	const url = derivePostgresUrl();

	console.log("• running agency reference (deno task reports)…");
	const ref = runReference();
	console.log("• running port (in-process)…");
	const port = await runPort(url);

	const refMap = new Map(ref.map((d) => [key(d), d]));
	const portMap = new Map(port.map((d) => [key(d), d]));
	console.log(`  reference: ${ref.length} stores · port: ${port.length} stores`);

	const onlyRef = [...refMap.keys()].filter((k) => !portMap.has(k));
	const onlyPort = [...portMap.keys()].filter((k) => !refMap.has(k));

	const diffs: string[] = [];
	const labelNotes: string[] = [];
	for (const k of refMap.keys()) {
		if (!portMap.has(k)) continue;
		const r = refMap.get(k)!, p = portMap.get(k)!;
		if (r.site !== p.site || r.store !== p.store) {
			labelNotes.push(
				`${k}: ref site/label ${r.site}/${r.store} vs port ${p.site}/${p.store} (GB/UK convention)`,
			);
		}
		// Exclude the cosmetic identity labels; compare all math + structure.
		const strip = (d: StoreDiagnosis) => ({ ...d, site: undefined, store: undefined });
		diff(strip(r), strip(p), k, diffs);
	}

	console.log("");
	if (onlyRef.length) console.log(`  stores only in reference: ${onlyRef.join(", ")}`);
	if (onlyPort.length) console.log(`  stores only in port:      ${onlyPort.join(", ")}`);
	for (const n of labelNotes) console.log(`  note ${n}`);

	if (diffs.length === 0 && onlyRef.length === 0 && onlyPort.length === 0) {
		console.log(`\n✔ PARITY: ${refMap.size} stores, all math identical (numeric tol ${EPS}).`);
		process.exit(0);
	}

	if (diffs.length) {
		console.log(`\n✖ ${diffs.length} field mismatch(es) on matched stores (first 25):`);
		for (const d of diffs.slice(0, 25)) console.log(`    ${d}`);
	}
	fail(
		`parity failed — ${diffs.length} field diffs, ${onlyRef.length} ref-only, ${onlyPort.length} port-only stores`,
	);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
