# effect-operator-kit

Shared Effect plumbing for the lidless operator CLIs (adguardctrl, immichctrl, jellyctrl, librenmsctrl, n8nctrl): config primitives, an HTTP request kernel, a typed error algebra, opt-in retry, redaction hooks, and MCP result helpers.

Design and API contract: [docs/design.md](docs/design.md). Service behavior stays in each ctrl repo; this package owns only the duplicated skeleton.
