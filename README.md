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
  amazonConstants.ts       # vendored, zero-import marketplace facts
  tools/salesDropDiagnosis/ {types,load,render,contract}.ts
bin/
  stdio.ts                 # MCP stdio frontend (Desktop / dev)
  cli.ts                   # @effect/cli frontend (dev / agency / parity)
test/
  parity_salesDropDiagnosis.ts   # vs the agency reference report, same DB
```

The hosted OAuth/metering frontend (P2) lives in a separate repo and imports
`registerTools` from here — it is a third frontend, not a fork.

## Use

```bash
bun install                       # or: deno install
cp .env.example .env              # set POSTGRES_URL to the client's target DB

# CLI
bun run bin/cli.ts salesDropDiagnosis --all-stores --format json
deno run -A bin/cli.ts salesDropDiagnosis --stores DE,US

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

## Status

P1 vertical slice: `salesDropDiagnosis` ported (inventory signal deferred to the
`inventoryPacing` tool). Next: `inventoryPacing`, then the `dbl-metrics-*` loaders.
