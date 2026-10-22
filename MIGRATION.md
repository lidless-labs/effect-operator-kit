# Migrating to 0.3.0

0.3.0 adds the pieces the lidless apps need to run behind Executor v2: explicit tool annotations, byte-bounded structured results, and a shared Streamable HTTP server. See the "Executor v2" section of [docs/design.md](docs/design.md) for the rules these implement.

## Pinning

The apps depend on this kit by git reference, and 0.2.0 was never tagged, so the old pins are bare SHAs (`#be71030`). For 0.3.0, pin the `v0.3.0` tag or the full commit SHA it points to:

```json
"@lidless-labs/effect-operator-kit": "github:lidless-labs/effect-operator-kit#v0.3.0"
```

Bump the pin in one app at a time, run its tests, then move to the next. `main` also carries `20d6a3d` ("preserve normalized API path prefixes"), which every app pinned at `be71030` picks up on the bump. `prepare` builds the package on a git install, so no `dist` is committed.

## Breaking changes

Two, both in `ok()`, `fail()` and `partialFailure()`:

1. They no longer set the non-standard `details` field. Apps or tests that read `result.details` should read `result.structuredContent` instead, or keep `details` for now with one call at startup:

   ```ts
   import { configureResults } from "@lidless-labs/effect-operator-kit";

   configureResults({ legacyDetails: true });
   ```

   Remove it once nothing reads `details`. Per call: `ok(payload, { legacyDetails: true })`.
2. The JSON text is compact, not two-space indented. Golden tests that compare `content[0].text` against `JSON.stringify(payload, null, 2)` should compare against `JSON.stringify(payload)`, or pass `{ pretty: true }`.

A result over the byte cap (90,000 by default) is now truncated with a marker instead of returned in full. Raise or lower it with `configureResults({ maxBytes })`. Keep it under 100,000 for Executor v2.

Everything else is additive.

## 1. Annotations

Give every tool one annotation object, and fail a test when one is missing or mislabeled.

```ts
import {
  ADDITIVE,
  DESTRUCTIVE,
  READ_ONLY,
  annotate,
  assertToolAnnotations,
  recordToolAnnotations,
} from "@lidless-labs/effect-operator-kit";

server.tool("items_list", "List items", schema, READ_ONLY, handler);
server.tool("items_create", "Create an item", schema, ADDITIVE, handler);
server.tool("items_delete", "Delete an item", schema, DESTRUCTIVE, handler);
// A write you have not classified is destructive by default:
server.tool("items_sync", "Sync items", schema, annotate({ title: "Sync items" }), handler);
// Opt out per tool when it is safe to run without a prompt:
server.tool("items_tag", "Tag an item", schema, annotate({ destructive: false, idempotent: true }), handler);
```

Apps that already keep their own constants (jellyctrl's `READ_ONLY`, `NON_DESTRUCTIVE`, `DESTRUCTIVE`) can delete them and import the kit's: `NON_DESTRUCTIVE` is `ADDITIVE`. Use `UPDATE` for a non-destructive write that is safe to repeat.

Apps that classify tools in a tier table (proxmox-mcp, immichctrl) can keep the table, type it as `Record<string, ToolTier>`, call `assertNoDrift(registeredNames, tiers)` in a test, and build annotations with `annotationsForTier` or `annotationsFromTiers`.

A test that registers every tool against the recording server catches a new tool with no annotations and a delete, reset, stop, exec or write tool that is not destructive:

```ts
const { server, tools } = recordToolAnnotations();
registerAllTools(server as never, client);
assertToolAnnotations(tools, { allowNonDestructive: ["items_preview_delete"] });
```

## 2. Results

Replace local `ok()` and `fail()` helpers with the kit's, or call `boundResult(result)` on the results a local helper builds. The adapters (`toMcpResult`, `runAsMcpTool`, `toToolHandler`) already bound successful results, so a handler wrapped in `toToolHandler` needs nothing more.

```ts
import { configureResults, ok } from "@lidless-labs/effect-operator-kit";

configureResults({ maxBytes: 60_000 }); // optional, once at startup

return ok({ items, nextOffset });
```

When a result is truncated, the text ends with a `[truncated: ...]` marker and `structuredContent` is `{ truncated: true, originalBytes, returnedBytes, maxBytes }`. Give list tools a `limit` and an `offset` so the model can page, since the kit cannot know an app's paging parameters.

## 3. Streamable HTTP

Replace the app's `http.ts` with the kit's server and keep its environment variable names through `envPrefix`:

```ts
import { runStreamableHttpServer } from "@lidless-labs/effect-operator-kit/streamable-http";

await runStreamableHttpServer({
  name: "example-mcp",
  envPrefix: "EXAMPLE_MCP_HTTP",
  defaultPort: 3120,
  createServer: () => createExampleMcpServer(config),
  distinctFrom: [config.apiKey],
});
```

The app needs `@modelcontextprotocol/sdk` in its own dependencies. Behind a reverse proxy, add the public name with `allowedHosts` (or `<PREFIX>_ALLOWED_HOSTS`). An app that serves each request from a fresh server, as jellyctrl does, sets `stateless: true`; per-tool policy checks stay in the app.

Differences from the copies being replaced: the token may be omitted on a loopback bind (it is still enforced when set), HTTP-level errors are JSON, and `distinctFrom` replaces the hand-written "token must differ from the API key" checks.

## Checklist per app

1. Bump the pin; run the app's tests.
2. Add annotations and the annotation test; run it and fix what it flags.
3. Switch to the kit's `ok`/`fail` or add `boundResult`; update golden tests for compact text and `structuredContent`.
4. Replace the HTTP transport; run the app's HTTP tests against the kit server.
5. Add the server to Executor with a Streamable HTTP URL and a bearer header, and confirm a delete-class tool prompts while a list tool does not.
