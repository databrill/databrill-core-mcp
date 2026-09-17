/**
 * MCP stdio frontend (P1 / Desktop / dev). Runs under bun and deno:
 *   bun run bin/stdio.ts        deno run -A bin/stdio.ts
 *
 * Connection resolution: DATABRILL_CONFIG maps each call's required `wsid` to
 * that workspace's own credential, with per-workspace pooling.
 * Pools are lazy (opened on first use) and closed on shutdown.
 */

import "temporal-polyfill/global";
import "dotenv/config";
import { Effect } from "effect";
import { exitValue, tryOrOperationError, tryPromiseOrOperationError } from "../src/effectErrors.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../src/config.ts";
import { acquireSqlProvider } from "../src/db.ts";
import { registerTools } from "../src/registerTools.ts";

const program = Effect.gen(function* () {
	const config = yield* loadConfig();
	if (config === null) {
		return yield* Effect.fail(
			new Error("DATABRILL_CONFIG is required; unscoped POSTGRES_URL mode is not supported"),
		);
	}
	const provider = yield* acquireSqlProvider(config);
	const server = yield* Effect.acquireRelease(
		Effect.suspend(() =>
			tryOrOperationError(() =>
				new Server(
					{ name: "databrill-core-mcp", version: "0.2.6" },
					{ capabilities: { tools: {} } },
				)
			)
		),
		(server) => Effect.orDie(tryPromiseOrOperationError(() => server.close())),
	);

	// One connection per workspace, so the tool's access kind changes nothing here.
	yield* registerTools(server, (args, _access) => provider.getSqlForArgs(args), config);
	yield* tryPromiseOrOperationError(() => server.connect(new StdioServerTransport()));
	// Input closure and process signals end the scope; remove listeners on every exit.
	yield* Effect.async<void>((resume) => {
		function shutdown() {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
			process.stdin.off("end", shutdown);
			resume(Effect.void);
		}
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
		process.stdin.on("end", shutdown);
		if (process.stdin.readableEnded) {
			shutdown();
		}
		return Effect.sync(() => {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
			process.stdin.off("end", shutdown);
		});
	});
}).pipe(Effect.scoped);

await Effect.runPromiseExit(program).then(exitValue);
