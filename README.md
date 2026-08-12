# databrill-core-mcp

Client-DB metric loaders and question tools for Databrill clients, exposed as
**MCP tools** and a **CLI**. Library-first: the tool logic is authored once as
`(params, sql) => result`; thin frontends supply the connection.

Runs under **bun** and **deno** (same files, one `package.json`/`node_modules`).

## Layout

```
src/
  contract.ts              # tool registry (the contract — single source of truth)
  registerTools.ts         # registerTools(server, getSql) — mounts tools on an MCP Server
  db.ts                    # getSql(POSTGRES_URL)
  clientData.ts            # client-DB data layer (portable descendant of digest _shared)
  config.ts                # optional multi-workspace config (DATABRILL_CONFIG) + routing
  amazonConstants.ts       # marketplace facts (mirrored from the monorepo's canonical module)
  sqlGuardrails.ts         # execution guards shared by the four SQL tools
  sqlParams.ts             # bind-parameter accumulator for the concatenating loaders
  tools/load*/             # ads, traffic, SQP, rank, economics, and TFL inventory
  tools/inventoryPacing/   # Amazon inventory-to-ad action
  tools/salesDropDiagnosis/ {types,load,render,contract}.ts
  tools/executeSql/        # guarded read-only SQL passthrough
  tools/{listTables,describeTable}/  # information_schema reads, own schema only
  tools/writeSql/          # one write statement, bounded by the role's grants
bin/
  stdio.ts                 # MCP stdio frontend (Desktop / dev)
  cli.ts                   # @effect/cli frontend (dev / agency / parity)
test/
  parity_salesDropDiagnosis.ts   # vs the agency reference report, same DB
```

The hosted OAuth/metering frontend imports `registerTools` from here — it is a
third frontend, not a fork.

## Use

```bash
bun install                       # or: deno install
cp .env.example .env              # set POSTGRES_URL to the client's target DB

# CLI
bun run bin/cli.ts salesDropDiagnosis --all-stores --format json
deno run -A bin/cli.ts salesDropDiagnosis --stores DE,US
deno run -A bin/cli.ts loadTflInventory --max-available 20

# MCP stdio server
bun run bin/stdio.ts
```

MCP client config (Desktop / dev):

```json
{ "mcpServers": { "databrill-core": { "command": "bun", "args": ["run", "bin/stdio.ts"] } } }
```

## Multiple workspaces

By default the server serves one client DB from `POSTGRES_URL`. To serve several
clients from a single server, set `DATABRILL_CONFIG` to a JSON file that maps
`wsid → { database, merchants }` (see `databrill.config.example.json`). Connection
strings use `${VAR}` placeholders expanded from the environment, so secrets stay
in `.env` and the config is safe to commit.

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

With a config the server:

- pools one connection per workspace, `search_path` set to `database.schema`
  (defaults to `w<wsid>`);
- adds an optional `wsid` argument (enum of the configured workspaces) to every
  tool, plus a `listWorkspaces` discovery tool;
- routes each call by `wsid` → the only workspace → inference from the `stores`
  argument (its country / merchant / region). A store that exists in more than one
  workspace is ambiguous and returns an error asking for an explicit `wsid`.

Each `merchantId` must belong to exactly one workspace.

Workspace-specific tools are announced only when their feature is enabled.
Set `features.tflInventory` to `true` only for a workspace with The Fulfillment
Lab data. In single-`POSTGRES_URL` mode, set
`DATABRILL_TFL_INVENTORY_ENABLED=true` instead. The CLI command enforces the same
flag.

The SQL tools use two flags, not one:

- `features.sql` (`DATABRILL_SQL_ENABLED`) gates `executeSql`, `listTables` and
  `describeTable`;
- `features.sqlWrite` (`DATABRILL_SQL_WRITE_ENABLED`) gates `writeSql` alone.

They are separate so a read-only session can announce the read tools and nothing
else — one flag could not express that, and filtering by tool name outside the
feature mechanism is exactly what the tools' declared access kind exists to avoid.

The CLI follows the same routing — pass `--wsid` (or rely on inference from
`--stores`), e.g. `deno run -A bin/cli.ts loadAds --wsid 100000001 --stores US --when P7D --groupBy store`.

## Parity

`test/parity_salesDropDiagnosis.ts` runs the agency reference
(`deno task reports salesDropDiagnosis`) and this port against the **same** client
DB and deep-compares every matched store (numeric tolerance 1e-9). It derives the
`POSTGRES_URL` from the agency repo's `pg_service.conf` + `.env.local`.

```bash
bun run test/parity_salesDropDiagnosis.ts            # client=exampleclient
CLIENT=exampleclient AGENCY_REPO=~/src/agency-repo bun run test/parity_salesDropDiagnosis.ts
```

## Tool surface

- `loadAds`, `loadTraffic`, `loadSqp`, `loadRank`, and `loadEconomics`
- `loadTflInventory` when the selected workspace enables `tflInventory`
- `inventoryPacing`
- `salesDropDiagnosis`
- `listTables`, `describeTable` and `executeSql` when the workspace enables `sql`
- `writeSql` when the workspace enables `sqlWrite`
- `listWorkspaces` on multi-workspace frontends

## The SQL tools

`executeSql` runs ONE caller-authored statement, `listTables` and `describeTable`
read `information_schema` scoped to the connection's own `current_schemas(false)`,
and `writeSql` runs one statement on a connection allowed to write.

```bash
deno run -A bin/cli.ts listTables
deno run -A bin/cli.ts describeTable --table amazon_merchant
deno run -A bin/cli.ts executeSql --sql 'SELECT "merchantId" FROM "amazon_merchant"' --limit 50
deno run -A bin/cli.ts writeSql --sql "UPDATE brand_config_x SET label = 'y' WHERE id = 1"
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
   row cap (500 default, 1000 maximum, a larger request rejected rather than
   clamped) and a 2 MiB serialized-JSON cap, with the result naming which cap
   truncated it.

No guard decides whether a statement may run by inspecting its SQL text. SQL
parsing is defeated by functions and `DO` blocks and is never a security boundary
here. Errors are reduced to the Postgres `code`, `message` and `position`; driver
errors, which carry the host and port, never reach the client.

Each tool declares `access: "read" | "write"` and receives the client the frontend
hands it. No tool opens, selects or reconfigures a connection, so read/write
routing stays enforceable at one seam in the frontend.
