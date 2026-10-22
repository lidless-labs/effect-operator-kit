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
