/**
 * Startup for this package's programs, which own the adjacent example config
 * and environment files. Their package root is therefore a useful fallback.
 * Unlike client-kit's library modules, these entry points do not infer the
 * location of a consumer's config from their own module location: cwd wins.
 */

import { config } from "dotenv";
import { Effect } from "effect";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));

/** Fill missing environment values from cwd, then from this package's `.env`. */
export function loadStartupEnv(): Effect.Effect<void, Error> {
	return Effect.try({
		try: () => {
			// Explicit options keep dotenv environment switches from changing precedence or printing on stdout.
			config({ path: resolve(process.cwd(), ".env"), quiet: true, debug: false, override: false });
			config({ path: resolve(packageRoot, ".env"), quiet: true, debug: false, override: false });
		},
		catch: (cause) => new Error("Cannot load startup environment", { cause }),
	});
}
