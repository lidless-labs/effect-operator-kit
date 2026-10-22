# effect-operator-kit

Shared Effect plumbing for the lidless operator CLIs (adguardctrl, immichctrl, jellyctrl, librenmsctrl, n8nctrl): config primitives, an HTTP request kernel, a typed error algebra, opt-in retry, redaction hooks, and MCP result helpers.

Design and API contract: [docs/design.md](docs/design.md). Service behavior stays in each ctrl repo; this package owns only the duplicated skeleton.

## Bounded, structured results

`ok()` and `fail()` emit compact JSON text plus `structuredContent` (for object payloads) and cap the result at 90,000 UTF-8 bytes by default, under Executor v2's 100,000 byte limit. The cap counts the text, `structuredContent` and any legacy `details` together, so an object payload that appears in both text and `structuredContent` counts twice. An oversize result is cut with a `[truncated: ...]` marker and `structuredContent` becomes `{ truncated: true, originalBytes, returnedBytes, maxBytes }`. `toMcpResult`, `runAsMcpTool` and `toToolHandler` apply the same cap to results an app built by hand.

```ts
import { configureResults } from "@lidless-labs/effect-operator-kit";

// Once at startup. Both fields are optional.
configureResults({ maxBytes: 60_000, legacyDetails: true });
```

The non-standard `details` field is no longer emitted. Set `legacyDetails: true` (process-wide or per call) while consumers still read it.
