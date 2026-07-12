Using `using-skillet` and `brigade-work` for the orchestration rules. No worker failures were reported. Brigade reported existing workspace changes despite the read-only task: `AGENTS.md`, `README.md`, plus 5 untracked files. No verification receipts were produced because this was scouting/design only.

**Shared Effect Operator Kit Design**

Recommended package: `@lidless-labs/effect-operator-kit`

Scope: shared plumbing for the five ctrl repos, not service behavior. The kit should own config primitives, fetch request mechanics, typed Effect errors, opt-in retry, redaction primitives, MCP result helpers, and thin CLI/MCP error adapters.

Validated duplicated-code signal:

| Concern | Current duplication |
|---|---:|
| Config/env parsing | ~299 LOC across dedicated config files |
| HTTP request/client scaffolding | ~1,746 LOC across primary clients |
| MCP/result helpers | ~139 LOC across helper files |
| Redaction helpers | ~83 LOC in AdGuard/LibreNMS, plus scattered usage elsewhere |
| Retry | ~80-120 LOC equivalent, split across inline loops and Immich helper |

Representative files: [n8n config](../n8n-ops-mcp/src/config.ts:1), [n8n client](../n8n-ops-mcp/src/client.ts:1), [adguard client](../adguard-mcp/src/adguard-client.ts:1), [immich retry](../immich-mcp/src/retry.ts:1), [librenms client](../librenms-mcp/src/librenms-client.ts:1), [jellyfin client](../jellyfin-mcp/src/client.ts:1).

**Package Modules**

```text
src/config.ts
src/errors.ts
src/http.ts
src/retry.ts
src/redaction.ts
src/result.ts
src/adapters/cli.ts
src/adapters/mcp.ts
src/index.ts
```

**Public API Shape**

Use current Effect 3 style imports from `"effect"` and `Data.TaggedError("Tag")<{ ... }>()`.

```ts
// errors.ts
export class ConfigError extends Data.TaggedError("ConfigError")<{
  key?: string; message: string; value?: string; cause?: unknown;
}> {}

export class AuthError extends Data.TaggedError("AuthError")<{
  method: string; path: string; status: number; body?: string;
}> {}
export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{ method: string; path: string; status: number; body?: string; }> {}
export class NotFoundError extends Data.TaggedError("NotFoundError")<{ method: string; path: string; status: number; body?: string; }> {}
export class TimeoutError extends Data.TaggedError("TimeoutError")<{ method: string; path: string; timeoutMs: number; }> {}
export class TransportError extends Data.TaggedError("TransportError")<{ method: string; path: string; cause: unknown; }> {}
export class ParseError extends Data.TaggedError("ParseError")<{ path?: string; body?: string; message: string; cause?: unknown; }> {}
export class UnexpectedStatusError extends Data.TaggedError("UnexpectedStatusError")<{
  method: string; path: string; status: number; body: string; expected: readonly number[];
}> {}

export type OperatorError =
  | ConfigError | AuthError | ForbiddenError | NotFoundError
  | TimeoutError | TransportError | ParseError | UnexpectedStatusError;
```

```ts
// config.ts
export interface EnvReader { get(key: string): string | undefined }

export const fromProcessEnv: (env?: NodeJS.ProcessEnv) => EnvReader;
export const requiredString: (env: EnvReader, key: string) => Effect.Effect<string, ConfigError>;
export const optionalString: (env: EnvReader, key: string, fallback?: string) => Effect.Effect<string | undefined, never>;
export const parseBooleanEnv: (env: EnvReader, key: string, fallback: boolean) => Effect.Effect<boolean, ConfigError>;
export const parseNumberEnv: (env: EnvReader, key: string, opts: { fallback?: number; min?: number; max?: number }) => Effect.Effect<number, ConfigError>;
export const parsePositiveIntEnv: (env: EnvReader, key: string, opts?: { fallback?: number; min?: number; max?: number }) => Effect.Effect<number, ConfigError>;
export const parseTimeoutEnv: (env: EnvReader, key: string, opts: { fallbackMs: number; minMs?: number; maxMs?: number; unit?: "ms" | "s" }) => Effect.Effect<number, ConfigError>;
export const normalizeBaseUrl: (value: string, opts?: { stripTrailingSlash?: boolean; ensurePath?: string }) => URL;
```

```ts
// http.ts
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type QueryValue = string | number | boolean | null | undefined;
export type BodyEncoding = "json" | "text" | "form" | "none";

export interface AuthStrategy {
  apply(headers: Headers): Effect.Effect<Headers, never>;
}

export interface HttpContext {
  baseUrl: URL;
  auth?: AuthStrategy;
  defaultHeaders?: HeadersInit;
  timeoutMs: number;
  fetch?: typeof fetch;
  redact?: (value: string) => string;
}

export interface HttpRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue | readonly QueryValue[]>;
  headers?: HeadersInit;
  body?: unknown;
  bodyEncoding?: BodyEncoding;
  responseType?: "json" | "text" | "none";
  timeoutMs?: number;
  expectedStatuses?: readonly number[];
  statusMapper?: (input: { status: number; method: string; path: string; bodyText: string; expectedStatuses: readonly number[] }) => OperatorError | null;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  bodyText: string;
  body: T;
}

export const buildUrl: (baseUrl: URL, path: string, query?: HttpRequest["query"]) => URL;
export const sendRequest: <T = unknown>(ctx: HttpContext, req: HttpRequest) => Effect.Effect<HttpResponse<T>, OperatorError>;
```

```ts
// retry.ts
export interface RetryPolicy {
  enabled: boolean;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: boolean;
  shouldRetry: (error: OperatorError) => boolean;
}

export const noRetry: RetryPolicy;
export const exponentialRetry: (opts: Partial<RetryPolicy>) => RetryPolicy;
export const withRetry: <A>(effect: Effect.Effect<A, OperatorError>, policy?: RetryPolicy) => Effect.Effect<A, OperatorError>;
```

```ts
// result.ts
export interface McpTextResult<T = unknown> {
  content: Array<{ type: "text"; text: string }>;
  details?: T;
  isError?: boolean;
}

export const ok: <T>(details: T) => McpTextResult<T>;
export const fail: (message: string, details?: unknown) => McpTextResult;
export const refuseUnconfirmed: (operation: string) => McpTextResult;
export const partialFailure: <T>(payload: {
  requested: number; attempted: number; succeeded: number; failed: number;
  skipped?: number; aborted?: boolean; results: T[];
}) => McpTextResult;
```

```ts
// redaction.ts
export type RedactFn = (value: string) => string;
export const redactString: (message: string, secrets?: string[]) => string;
export const defaultRedact: RedactFn;
```

```ts
// adapters/cli.ts
export type StderrWriter = (line: string) => void;
export const formatOperatorError: (error: OperatorError) => string;
export const exitCodeForOperatorError: (error: OperatorError) => number;
export const writeOperatorError: (error: OperatorError, err: StderrWriter) => void;
export const runWithCliErrors: <A>(effect: Effect.Effect<A, OperatorError>, deps: {
  err: StderrWriter;
  formatError?: (e: OperatorError) => string;
  exitCodeFor?: (e: OperatorError) => number;
  redact?: RedactFn;
}) => Promise<{ ok: true; value: A } | { ok: false; exitCode: number }>;
```

```ts
// adapters/mcp.ts
export const operatorErrorMessage: (error: unknown) => string;
export const toMcpResult: (effect: Effect.Effect<McpTextResult, OperatorError>, redact?: RedactFn) => Effect.Effect<McpTextResult, never>;
export const runAsMcpTool: (effect: Effect.Effect<McpTextResult, OperatorError>, redact?: RedactFn) => Promise<McpTextResult>;
export const toToolHandler: <Args>(handler: (args: Args) => Effect.Effect<McpTextResult, OperatorError>, redact?: RedactFn) => (args: Args) => Promise<McpTextResult>;
```

CLI and MCP adapters redact formatted error output by default; callers opt out by supplying an identity `redact` hook.

**Keep Out Of The Kit**

These must stay repo-owned or injectable:

- Auth headers: n8n `X-N8N-API-KEY`, AdGuard Basic auth, LibreNMS `x-auth-token`, Jellyfin `X-Emby-Token`, Immich SDK auth.
- MCP registration: `server.tool`, zod/typebox schemas, OpenClaw plugin registration.
- Write gates: n8n `enableEdit` and `enableCredentialsWrite`, destructive gates, `confirm: true` behavior.
- Backup/delete safety, especially n8n workflow snapshots and path confinement.
- Pagination and endpoint semantics.
- Exact user-facing error copy, CLI text, exit-code mapping, and MCP payload wrapping.
- Immich SDK internals.

**Adoption Plan**

Use an npm package. Git subtree is a temporary fallback for offline builds. Copier templates are only useful for new repo bootstraps.

Rollout order:

1. Publish `@lidless-labs/effect-operator-kit` as `0.x`.
2. Adopt result helpers through repo-local wrappers first.
3. Replace config parser internals while preserving env names and exact messages.
4. Adopt retry only where retry already exists. Default remains disabled.
5. Move HTTP request kernels last, one repo at a time.
6. Add CLI/MCP adapters only after golden tests protect exact payload and exit behavior.

For `n8n-ops-mcp`, the risk order is:

1. [src/tools/result.ts](../n8n-ops-mcp/src/tools/result.ts:1), low risk.
2. [src/config.ts](../n8n-ops-mcp/src/config.ts:1) and `mcp-server.ts` env parsing, medium risk.
3. [src/client.ts](../n8n-ops-mcp/src/client.ts:1) request kernel and errors, high risk.
4. [src/cli.ts](../n8n-ops-mcp/src/cli.ts:1) CLI boundary, high operator-facing risk.

**Regression Gates**

Before adoption is considered safe:

- n8n: confirm failures make no fetch call, credential writes remain double-gated, `details` stays present, backup snapshot still precedes save/delete.
- AdGuard/LibreNMS: 2-attempt retry applies to transport/5xx only, not 4xx.
- Immich: SDK initialization remains SDK-owned.
- Jellyfin: `isError` and refusal shape remain stable.
- All repos: auth headers are exact, secrets never appear in thrown messages or tool results, exit codes and CLI text stay golden-tested.

No UI surface is involved. The main operator-experience risk is CLI/MCP drift: changed wording, missing `details`, altered `isError`, changed exit codes, or changed confirmation prompts.
