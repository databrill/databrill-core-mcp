# databrill-core-mcp

Client-DB metric loaders and question tools for Databrill clients, exposed as
**MCP tools** and a **CLI**. Library-first: the tool logic is authored once as
`(params, sql) => Effect<Result, Error>`; frontends supply the connection.

Runs under **bun** and **deno** (same files, one `package.json`/`node_modules`).

## Layout

```
src/
  contract.ts              # tool registry (the contract — single source of truth)
  registerTools.ts         # registerTools(server, getSql) — mounts tools on an MCP Server
  db.ts                    # registry-selected pools + explicit cleanup
  clientData.ts            # client-DB data layer (portable descendant of digest _shared)
  config.ts                # workspace registry (DATABRILL_CONFIG) + explicit routing
  startup.ts               # cwd-first environment loading and package-root fallback
  amazonConstants.ts       # marketplace facts (mirrored from the monorepo's canonical module)
  sqlGuardrails.ts         # execution guards shared by the four SQL tools
  tools/load*/             # ads, traffic, SQP, rank, economics, products, FBA stockouts, and TFL inventory
  tools/inventoryPacing/   # Amazon inventory-to-ad action
  tools/salesDropDiagnosis/ {types,load,render,contract}.ts
  tools/executeSql/        # guarded read-only SQL passthrough
  tools/{listTables,describeTable}/  # information_schema reads, own schema only
  tools/writeSql/          # one write statement, bounded by the role's grants
bin/
  stdio.ts                 # MCP stdio frontend (Desktop / dev)
  cli.ts                   # effect/cli frontend (dev / agency / parity)
test/
  parity_salesDropDiagnosis.ts   # vs the agency reference report, same DB
```

The hosted OAuth/metering frontend imports `registerTools` from here — it is a
third frontend, not a fork.

## Use

```bash
bun install                       # or: deno install
cp .env.example .env              # set DATABRILL_CONFIG and its per-workspace URLs

# CLI
bun run bin/cli.ts listWorkspaces
bun run bin/cli.ts salesDropDiagnosis --wsid 100000001 --all-stores --format json
deno run -A bin/cli.ts salesDropDiagnosis --wsid 100000001 --stores DE,US
deno run -A bin/cli.ts loadTflInventory --wsid 100000001 --max-available 20

# MCP stdio server
bun run bin/stdio.ts
```

MCP client config (Desktop / dev):

```json
{
	"mcpServers": {
		"databrill-core": {
			"command": "bun",
			"args": ["run", "/absolute/path/to/databrill-core-mcp/bin/stdio.ts"],
			"env": {
				"DATABRILL_CONFIG": "/absolute/path/to/databrill.config.json"
			}
		}
	}
}
```

Replace both absolute paths with your own locations. The CLI and stdio server load `.env`
from the current directory, then from the package root, filling only variables that are
not already set. Relative `DATABRILL_CONFIG` paths try the current directory first, then
the package root if no file is there. A config that exists but cannot be read, or is invalid,
fails at startup.

`listWorkspaces` prints the configured workspace ids, labels and merchants as JSON without
opening a database connection. Run it before a data command to find its required `--wsid`.

## Library execution

SDK registration, string argument validation, SQL client construction, date parsing,
advertising SQL compilation, report validation, JSON serialization and diagnosis
rendering return `Result<Value, Error>` and execute when called.
Read their `Failure`/`Success` result directly. Infallible helpers and query-builder
construction return ordinary values.

Advertising, report, sales-diagnosis, inventory-pacing and TFL inventory loaders,
the `McpTool.run` contract, transaction programs, hooks, provider acquisition and
teardown, and application lifecycles use
lazy Effect programs. Use `yield*` to compose
an Effect inside an Effect, and `yield* Effect.fromResult(…)` for a `Result` (Effect 4's
`Effect.gen` does not accept a yielded `Result`); run the runtime only at an
application boundary. Constructing a database program does not query or acquire
a pool.

`registerTools` returns `Result<void, Error>` after registering the SDK handlers.
It accepts connection resolvers returning `Effect<Sql, Error>` or
`Result<Sql, Error>`; hosted lookups are synchronous while a local provider may
wait for concurrent teardown. Optional `getHooks` callbacks return plain
`McpToolHooks`, and each asynchronous `assertIdentity` hook returns
`Effect<void, Error>`. SDK request handlers execute async dispatch with the
request's cancellation signal. The synchronous list handler returns its concrete
protocol result directly.

`createSqlProvider(config)` constructs an empty provider. Repeated and concurrent
`getSqlForArgs` executions share each workspace's acquired pool. Execute
`endAll()` when the owner finishes; it attempts every pool and retains failed
handles for a later retry. `acquireSqlProvider(config)` registers pool cleanup with the owning Effect scope.
The CLI and stdio programs finish with `Effect.scoped`; stdio acquires its server in the same
scope, so server shutdown precedes pool teardown. Cleanup failures become defects and remain
in the Cause alongside work failures and interruption.

Effect is a public dependency pinned to 4.1.4. Consumers composing local package
source must resolve the same Effect version: different versions have incompatible
private iterator types. The database driver's own query objects and transaction
callbacks retain their native contracts; owned tool programs remain Effects.

## Workspace registry

Set `DATABRILL_CONFIG` to a JSON file that maps
`wsid → { database, merchants }` (see `databrill.config.example.json`). Connection
strings use `${VAR}` placeholders expanded from the environment, so secrets stay
in `.env` and the config is safe to commit. Each entry must use its workspace's
own provisioned role and its own environment variable.

```jsonc
{
	"version": 1,
	"workspaces": {
		"100000001": {
			"label": "Example Workspace A",
			"features": { "tflInventory": true },
			"database": { "postgresUrl": "${WORKSPACE_A_POSTGRES_URL}", "schema": "w100000001" },
			"merchants": { "AEXAMPLE0000001": { "name": "Example Seller A", "countries": ["US", "CA"] } }
		}
	}
}
```

`database.schema` may be omitted: the parser then uses `w<wsid>`, which is the
value the example above states explicitly.

With a config the server:

- keeps one connection pool per workspace, taking each registry entry's
  connection string at its word;
- adds a required `wsid` argument (enum of the configured workspaces that may
  call it) to every tool, plus a `listWorkspaces` discovery tool;
- routes each call only by that explicit `wsid`. Registry size and `stores` never
  select a workspace.

Each `merchantId` must belong to exactly one workspace.

Workspace-specific tools are announced only when their feature is enabled.
Set `features.tflInventory` to `true` only for a workspace with The Fulfillment
Lab data. The CLI command enforces the same flag.

The SQL tools use two flags, not one:

- `features.sql` enables `executeSql`, `listTables` and
  `describeTable`;
- `features.sqlWrite` enables `writeSql` alone.

They are separate so a read-only session can announce the read tools and nothing
else — one flag could not express that, and filtering by tool name outside the
feature mechanism is exactly what the tools' declared access kind exists to avoid.

The CLI data commands follow the same routing and require `--wsid`, e.g.
`deno run -A bin/cli.ts loadAds --wsid 100000001 --stores US --when P7D --groupBy store`.

## Parity

`test/parity_salesDropDiagnosis.ts` runs the agency reference
(`deno task reports salesDropDiagnosis`) and this port against the **same** client
DB and deep-compares every matched store (numeric tolerance 1e-9). It derives the
`POSTGRES_URL` from the agency repo's `pg_service.conf` + `.env.local`.
That entry's login predates Databrill's role provisioning, so the script copies
the entry's `search_path` into the URL. It is the one place in this package that
does: a provisioned workspace role already carries its `search_path`, and a
connection made as one should never set it.

```bash
bun run test/parity_salesDropDiagnosis.ts            # client=exampleclient
CLIENT=exampleclient AGENCY_REPO=~/src/agency-repo bun run test/parity_salesDropDiagnosis.ts
```

## Tool surface

- `loadAds`, `loadTraffic`, `loadSqp`, `loadRank`, and `loadEconomics`
- `loadProducts` for product discovery (see below)
- `loadAmazonFbaStockouts` for stockout episodes per merchant, marketplace and FNSKU, from FBA inventory history and, for the days before a store's history starts, the FBA inventory ledger; `stores` is required
- `loadTflInventory` when the selected workspace enables `tflInventory`
- `inventoryPacing`
- `salesDropDiagnosis`
- `listTables`, `describeTable` and `executeSql` when the workspace enables `sql`
- `writeSql` when the workspace enables `sqlWrite`
- `listWorkspaces` on every frontend that passes a workspace directory
- `submitFeedback` on frontends that supply the authenticated feedback capability
  to `registerTools`. The hosted MCP server supplies it; local stdio does not.
  It accepts only a `message` and sends it as the signed-in user's feedback. A
  problem that needs an answer goes to Contact support, under Help in DataBrill.

## Product discovery

Use `loadProducts` before choosing products for another loader. The default call lists
workspace-wide families with their labels and ASIN counts. Choose `level: "parentAsin"`,
`"asin"` or `"sku"` for marketplace-scoped detail; family and parent ASIN are independent
groupings. Stores accept the same syntax as `loadAds` and default to all active real stores.

`columns` selects a comma-separated projection; each response lists the available columns.
`products` accepts families, parent ASINs or child ASINs. Parent ASINs select their children separately in each requested marketplace; configured families remain workspace-wide. `search` matches a literal
substring in titles or family names. Missing labels remain null. Localized ASIN titles and
parents come from the first available country in `meta.titleCountryPriority`; parent titles
come from the parent catalog row, without substituting a child title.

Results default to 200 rows (maximum 2000) and share the SQL tools’ compact-JSON byte cap.
`meta.totalCount` reports the full matching count. Advance `offset` by `meta.rowCount`;
if no row fits the byte cap, select fewer columns. `includeUnassigned: false` excludes
products without a family, while `meta.unassignedCount` reports their count before exclusion.
If a core source table is absent the result is empty and `meta.missingTables` names it;
missing traffic or ontology tables disable only those optional lookups.

For example:

```bash
bun run bin/cli.ts loadProducts --wsid 100000001 --level asin --stores DE --columns asin,title --limit 50
```

## The SQL tools

`executeSql` runs ONE caller-authored statement, `listTables` and `describeTable`
read `information_schema` scoped to the connection's own `current_schemas(false)`,
and `writeSql` runs one statement on a connection allowed to write.

```bash
deno run -A bin/cli.ts listTables --wsid 100000001
deno run -A bin/cli.ts describeTable --wsid 100000001 --table amazon_merchant
deno run -A bin/cli.ts executeSql --wsid 100000001 --sql 'SELECT "merchantId" FROM "amazon_merchant"' --limit 50
deno run -A bin/cli.ts writeSql --wsid 100000001 --sql "UPDATE brand_config_x SET label = 'y' WHERE id = 1"
```

What bounds these tools, in order of importance:

1. The GRANTS on the Postgres role the connection authenticates as. This is the
   read/write boundary and the tenant-isolation boundary. Nothing else is.
2. Layers on top, in `src/sqlGuardrails.ts`: exactly one statement,
   forced over the EXTENDED query protocol (postgres.js's `unsafe()` selects the
   SIMPLE protocol when no bind parameters are passed, and the simple protocol
   executes stacked statements — every statement here goes through `.cursor()`
   instead, and there is no fetch-all path); a `READ ONLY` transaction for reads;
   `SET LOCAL statement_timeout` from a constant that no caller can influence; a
   row cap and a 2 MiB cap on the compact JSON text of the whole result —
   `meta` and the `data` array together, as the MCP response encodes them — with
   the result naming which cap truncated it.

   Both caps apply to `writeSql` as well as to the read tools. The row cap is 500
   by default for `executeSql`, which accepts a `limit` up to 1000 and rejects a
   larger request rather than clamping it; for `writeSql` it is always 1000, since
   that tool takes no `limit` and a caller cannot run the statement again to ask
   for more. The caps bound what a statement RETURNS and never what it does: a
   truncated write has still run and committed in full, `meta.rowsAffected` is its
   true total, and the notice says to read the rest with `executeSql` rather than
   to re-run anything.

No guard decides whether a statement may run by inspecting its SQL text. SQL
parsing is defeated by functions and `DO` blocks and is never a security boundary
here. Errors are reduced to the Postgres `code`, `message` and `position`; driver
errors, which carry the host and port, never reach the client.

Each tool has an `access` of `"read" | "write"` (absent means `"read"`) and
receives the client the frontend hands it. No tool opens, selects or
reconfigures a connection, so read/write routing stays enforceable in one place
in the frontend.
