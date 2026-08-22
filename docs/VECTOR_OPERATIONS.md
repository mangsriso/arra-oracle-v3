# Vector Operations

## Canonical production launch contract

Every process that reads or writes vector collections—the main Oracle server,
vector sidecar, and indexer daemon—must receive the same embedding environment.
The provider/model identity used to create a collection must also be used for
queries and later indexing.

Runtime configuration resolves in this order:

1. `ORACLE_EMBEDDING_PROVIDER` and `ORACLE_EMBEDDING_MODEL`, when exported by
   the process launcher.
2. The collection's `provider` and `model` in
   `$ORACLE_DATA_DIR/vector-server.json`.
3. Built-in registry defaults when the config file is absent.

The collection name and `dataPath` come from the same registry entry. Provider
credentials and provider-specific endpoints remain environment variables; do
not put credential values in `vector-server.json` or documentation. For an
OpenAI-compatible provider, the relevant names are `ORACLE_OPENAI_API_KEY` and
`ORACLE_OPENAI_BASE_URL`.

An operator should launch the main server, vector sidecar, and indexer daemon
through service definitions that export the same environment source. Direct
shell launches must reproduce that environment explicitly.

## Destructive reindex

Both reindex APIs delete the selected collection before rebuilding it:

- `POST /api/vector/index/start`
- `POST /api/indexer/start`

They reject the request unless its JSON body includes the exact acknowledgement:

```json
{
  "confirmation": "REINDEX_DELETE_COLLECTION",
  "model": "bge-m3"
}
```

Confirmation is an operational interlock, not authentication. Access control
must still protect these endpoints. Before a confirmed rebuild, verify the
database backup, collection target, provider/model identity, and registry data
path. A missing or incorrect confirmation must not open a database, create an
embedding provider, start a background job, or touch a collection.

## External writer visibility

The server shares one LanceDB adapter per model, but another process may append
or upsert rows through the same on-disk collection. Every adapter read checks
out the latest table manifest before counting or querying, so a completed
backfill becomes visible on the next API/search request without a restart.

`GET /api/vector/stats` reports `version` and `refreshed_at` for each local
LanceDB engine. A successful external write should advance the version and the
next stats request should return the new row count. These fields are omitted
for vector backends that do not expose a native revision.

## Remote vector proxy (VECTOR_URL)

- The caller NEVER trusts the remote's `score`. handleSearch recomputes every
  proxied vector result as `normalizeVectorDistance(distance ?? 2)` — one
  normalizer owns the scale on this node regardless of the remote's code
  version. A result arriving without `distance` scores 0 and adds a warning
  to the response.
- The `vector-server.ts` sidecar does NOT serve `/api/search`; hybrid search
  through `vectorProxy.search()` against the sidecar 404s -> null -> FTS5-only
  fallback. A proxy deployment needs a full oracle server (or a new sidecar
  route) behind VECTOR_URL.
- Setting VECTOR_URL also makes the gateway synthesize an `/api/search` route
  to the vector service at the Elysia layer (src/gateway/config.ts) — two
  proxy layers engage from one env var.
- `VECTOR_FALLBACK` (src/config.ts) is exported but read nowhere — the
  fts5-fallback behavior is hardcoded in handlers.ts.
