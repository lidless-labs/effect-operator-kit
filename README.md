# effect-operator-kit

Shared Effect plumbing for the lidless operator CLIs (adguardctrl, immichctrl, jellyctrl, librenmsctrl, n8nctrl): config primitives, an HTTP request kernel, a typed error algebra, opt-in retry, redaction hooks, and MCP result helpers.

Design and API contract: [docs/design.md](docs/design.md). Service behavior stays in each ctrl repo; this package owns only the duplicated skeleton.

## Tool annotations

`annotate`, the tier presets (`READ_ONLY`, `ADDITIVE`, `UPDATE`, `DESTRUCTIVE`), `assertNoDrift` and `assertToolAnnotations` give every MCP tool explicit hints. Anything not declared read-only is `destructiveHint: true` unless the app opts out per tool, because Executor v2 prompts only on `destructiveHint === true`.

```ts
import { annotate, READ_ONLY } from "@lidless-labs/effect-operator-kit";

server.tool("items_list", "List items", schema, READ_ONLY, handler);
server.tool("items_create", "Create an item", schema, annotate({ destructive: false }), handler);
server.tool("items_delete", "Delete an item", schema, annotate(), handler);
```

## Bounded, structured results

`ok()` and `fail()` emit compact JSON text plus `structuredContent` (for object payloads) and cap the result at 90,000 UTF-8 bytes by default, under Executor v2's 100,000 byte limit. The cap is measured on the serialized result, so the text block (escaped again as JSON), `structuredContent` and any legacy `details` all count, and an object payload that appears in both text and `structuredContent` counts twice. An oversize result is cut with a `[truncated: ...]` marker and `structuredContent` becomes `{ truncated: true, originalBytes, returnedBytes, maxBytes }`. `toMcpResult`, `runAsMcpTool` and `toToolHandler` apply the same cap to results an app built by hand.

```ts
import { configureResults } from "@lidless-labs/effect-operator-kit";

// Once at startup. Both fields are optional.
configureResults({ maxBytes: 60_000, legacyDetails: true });
```

The non-standard `details` field is no longer emitted. Set `legacyDetails: true` (process-wide or per call) while consumers still read it.

## HTTP response limits

`sendRequest` keeps `timeoutMs` active until the entire response body has been
consumed. A stalled body fails with `TimeoutError`. Interrupting the Effect
aborts the fetch and cancels its body reader.

Responses default to a 10 MiB limit on bytes delivered by the response stream,
including decompressed bytes when fetch decodes content encoding. Set
`HttpContext.maxResponseBytes` for a client default or
`HttpRequest.maxResponseBytes` for a request override. The cap must be a positive
safe integer. Success and error bodies share the cap, including
`responseType: "none"`, which still returns bounded `bodyText`. Oversized bodies
fail with `ResponseTooLargeError`, which the default retry predicate does not
retry. Consumers with exhaustive `OperatorError` switches must handle this tag.

Retries remain disabled unless the caller opts in through `withRetry`. A body
timeout can occur after the server has applied a mutation. Enable retries only
when the operation is safe to repeat or the server honors an idempotency key.

## Streamable HTTP server

`@lidless-labs/effect-operator-kit/streamable-http` replaces the per-repo copies of the HTTP transport. It needs `@modelcontextprotocol/sdk` (an optional peer dependency, so the main entry point does not load it).

```ts
import { runStreamableHttpServer } from "@lidless-labs/effect-operator-kit/streamable-http";

await runStreamableHttpServer({
  name: "example-mcp",
  envPrefix: "EXAMPLE_MCP_HTTP", // EXAMPLE_MCP_HTTP_TOKEN, _HOST, _PORT, _ALLOWED_HOSTS, _ALLOWED_ORIGINS
  defaultPort: 3120,
  createServer: () => createExampleMcpServer(config),
  distinctFrom: [config.apiKey],
});
```

It binds loopback by default and refuses a wildcard bind. A bearer token (32 characters or more, constant-time compare) is required on any non-loopback bind and enforced whenever one is set. Host and Origin are checked against loopback, the bound address and the explicit `allowedHosts` / `allowedOrigins` lists (a guard against cross-site requests; the server sends no CORS headers and does not answer preflight, so it is for non-browser MCP clients), bodies are capped at 1 MiB, and sessions are capped (128) and reaped when idle (30 minutes). Pass `stateless: true` for one server per request with no sessions.
