# effect-operator-kit

Shared Effect plumbing for the lidless operator CLIs (adguardctrl, immichctrl, jellyctrl, librenmsctrl, n8nctrl): config primitives, an HTTP request kernel, a typed error algebra, opt-in retry, redaction hooks, and MCP result helpers.

Design and API contract: [docs/design.md](docs/design.md). Service behavior stays in each ctrl repo; this package owns only the duplicated skeleton.

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

It binds loopback by default and refuses a wildcard bind. A bearer token (32 characters or more, constant-time compare) is required on any non-loopback bind and enforced whenever one is set. Host and Origin are checked against loopback, the bound address and the explicit `allowedHosts` / `allowedOrigins` lists, bodies are capped at 1 MiB, and sessions are capped (128) and reaped when idle (30 minutes). Pass `stateless: true` for one server per request with no sessions.
