/**
 * Shared Streamable HTTP transport for the lidless MCP servers and ctrl apps.
 *
 * Import from `@lidless-labs/effect-operator-kit/streamable-http`. It is a
 * separate entry point because it needs `@modelcontextprotocol/sdk`, which the
 * rest of the kit does not.
 *
 * Defaults: bind to loopback, refuse a wildcard bind, require a bearer token
 * (at least 32 characters, compared in constant time) whenever the bind is not
 * loopback, check the Host and Origin headers against DNS rebinding and
 * cross-site requests, cap the request body at 1 MiB, answer with JSON, and
 * cap and reap idle sessions.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
export const DEFAULT_MAX_SESSIONS = 128;
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
export const MIN_TOKEN_LENGTH = 32;

/** The slice of `McpServer` or `Server` the factory needs. */
export interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/** A server plus extra cleanup, for apps that own a client or pool per server. */
export interface ServerResource {
  server: ConnectableServer;
  dispose(): Promise<void> | void;
}

export type ServerFactory = () =>
  | ConnectableServer
  | ServerResource
  | Promise<ConnectableServer | ServerResource>;

export interface StreamableHttpOptions {
  /** Called once per session, or once per request in stateless mode. */
  createServer: ServerFactory;
  /** Used in log lines and error messages. Defaults to `mcp`. */
  name?: string;
  /**
   * Prefix for the environment variables: `<PREFIX>_TOKEN`, `<PREFIX>_HOST`,
   * `<PREFIX>_PORT`, `<PREFIX>_ALLOWED_HOSTS` and `<PREFIX>_ALLOWED_ORIGINS`
   * (comma separated). Keeps each app's existing variable names, for example
   * `WAZUH_MCP_HTTP`. Explicit options below win over the environment.
   */
  envPrefix?: string;
  /** Environment to read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  host?: string;
  port?: number;
  /** Used when neither `port` nor the environment sets one. Defaults to 3000. */
  defaultPort?: number;
  token?: string;
  /**
   * Upstream credentials the token must differ from, so a leaked MCP token is
   * never also the backend credential.
   */
  distinctFrom?: readonly string[];
  /**
   * Extra Host header values to accept, for a reverse proxy in front of the
   * server. A bare name (`mcp.example.com`) matches any port; `name:port`
   * matches that port only.
   */
  allowedHosts?: readonly string[];
  /** Extra Origin values to accept, as exact origins like `https://host`. */
  allowedOrigins?: readonly string[];
  /** One server and transport per POST, no sessions. GET and DELETE answer 405. */
  stateless?: boolean;
  path?: string;
  healthPath?: string;
  maxBodyBytes?: number;
  maxSessions?: number;
  sessionIdleMs?: number;
}

export interface StreamableHttpHandle {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "[::]"]);

const stripBrackets = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

/** True for localhost, 127.0.0.0/8, ::1 and ::ffff:127.0.0.0/8. */
export const isLoopbackHost = (host: string): boolean => {
  const bare = stripBrackets(host.trim().toLowerCase());
  if (LOOPBACK_NAMES.has(bare)) return true;
  if (isIP(bare) === 4) return bare.startsWith("127.");
  return isIP(bare) === 6 && /^::ffff:(127\.|7f[0-9a-f]{2}:)/.test(bare);
};

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Constant-time string equality: equal-length digests, so length is not leaked. */
export const secretsEqual = (a: string, b: string): boolean =>
  timingSafeEqual(digest(a), digest(b));

const bearerOf = (authorization: string | undefined): string =>
  authorization?.match(/^Bearer (.+)$/i)?.[1]?.trim() ?? "";

const AUTHORITY = /^(\[[a-f\d:.]+\]|[a-z\d.-]+)(:\d+)?$/i;

interface HostRule {
  hostname: string;
  port: string | undefined;
}

const parseHostRule = (value: string): HostRule | undefined => {
  const trimmed = value.trim().toLowerCase();
  const match = AUTHORITY.exec(trimmed);
  if (!match) return undefined;
  const hostname = match[1]!;
  return { hostname, port: match[2]?.slice(1) };
};

const matchesHost = (headerValue: string | undefined, rules: readonly HostRule[]): boolean => {
  if (!headerValue) return false;
  // An authority only: no userinfo, path, whitespace or URL normalization tricks.
  const supplied = parseHostRule(headerValue);
  if (!supplied) return false;
  try {
    if (new URL(`http://${headerValue}`).hostname !== supplied.hostname) return false;
  } catch {
    return false;
  }
  return rules.some(
    (rule) =>
      rule.hostname === supplied.hostname &&
      (rule.port === undefined || rule.port === supplied.port),
  );
};

const matchesOrigin = (origin: string | undefined, allowed: ReadonlySet<string>): boolean => {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.origin !== origin) return false;
    return isLoopbackHost(url.hostname) || allowed.has(origin);
  } catch {
    return false;
  }
};

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
};

const sendRpcError = (response: ServerResponse, status: number, message: string): void =>
  sendJson(response, status, { jsonrpc: "2.0", error: { code: -32603, message }, id: null });

const readJsonBody = async (request: IncomingMessage, maxBytes: number): Promise<unknown> => {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new RequestError(413, "Request body too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the socket alive long enough to answer 413 on an oversized chunked body.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new RequestError(413, "Request body too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "Invalid JSON request body");
  }
};

const originFormPath = (target: string | undefined): string | undefined => {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) {
    return undefined;
  }
  try {
    return new URL(target, "http://localhost").pathname;
  } catch {
    return undefined;
  }
};

const splitList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

interface ResolvedConfig {
  name: string;
  host: string;
  port: number;
  token: string;
  allowedHosts: HostRule[];
  allowedOrigins: Set<string>;
}

const resolveConfig = (options: StreamableHttpOptions): ResolvedConfig => {
  const env = options.env ?? process.env;
  const prefix = options.envPrefix;
  const fromEnv = (suffix: string): string | undefined =>
    prefix === undefined ? undefined : env[`${prefix}_${suffix}`];
  const label = (suffix: string): string => (prefix ? `${prefix}_${suffix}` : suffix.toLowerCase());

  const host = (options.host ?? fromEnv("HOST") ?? "127.0.0.1").trim();
  if (WILDCARD_HOSTS.has(host.toLowerCase())) {
    throw new Error(
      `${label("HOST")} must be a specific address, not a wildcard; bind the interface clients will use`,
    );
  }
  if (host.includes("/") || host.includes("@") || /\s/.test(host)) {
    throw new Error(`${label("HOST")} must be a host name or address`);
  }

  let port = options.port;
  if (port === undefined) {
    const raw = (fromEnv("PORT") ?? String(options.defaultPort ?? 3000)).trim();
    if (!/^\d+$/.test(raw)) throw new Error(`${label("PORT")} must be an integer from 0 to 65535`);
    port = Number(raw);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${label("PORT")} must be an integer from 0 to 65535`);
  }

  // Header values arrive trimmed, so compare against the trimmed secret.
  const token = (options.token ?? fromEnv("TOKEN") ?? "").trim();
  if (token === "" && !isLoopbackHost(host)) {
    throw new Error(
      `${label("TOKEN")} is required when binding ${host}; only a loopback bind may run without one`,
    );
  }
  if (token !== "") {
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `${label("TOKEN")} must be at least ${MIN_TOKEN_LENGTH} characters (for example openssl rand -hex 32)`,
      );
    }
    if (options.distinctFrom?.some((credential) => credential && secretsEqual(token, credential))) {
      throw new Error(`${label("TOKEN")} must differ from the upstream credentials`);
    }
  }

  const rules: HostRule[] = [{ hostname: stripBrackets(host).toLowerCase(), port: undefined }];
  if (rules[0]!.hostname.includes(":")) rules[0]!.hostname = `[${rules[0]!.hostname}]`;
  for (const name of ["localhost", "127.0.0.1", "[::1]"]) rules.push({ hostname: name, port: undefined });
  for (const entry of [...(options.allowedHosts ?? []), ...splitList(fromEnv("ALLOWED_HOSTS"))]) {
    const rule = parseHostRule(entry);
    if (!rule) throw new Error(`${label("ALLOWED_HOSTS")} has an invalid entry: ${entry}`);
    rules.push(rule);
  }

  const allowedOrigins = new Set<string>();
  for (const entry of [...(options.allowedOrigins ?? []), ...splitList(fromEnv("ALLOWED_ORIGINS"))]) {
    let origin: string;
    try {
      origin = new URL(entry).origin;
    } catch {
      throw new Error(`${label("ALLOWED_ORIGINS")} has an invalid entry: ${entry}`);
    }
    if (origin === "null" || origin !== entry.replace(/\/$/, "")) {
      throw new Error(`${label("ALLOWED_ORIGINS")} entries must be exact origins like https://host: ${entry}`);
    }
    allowedOrigins.add(origin);
  }

  return { name: options.name ?? "mcp", host, port, token, allowedHosts: rules, allowedOrigins };
};

interface Session {
  server: ConnectableServer;
  dispose: (() => Promise<void> | void) | undefined;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
  active: number;
  disposed?: Promise<void>;
}

const unwrap = (created: ConnectableServer | ServerResource): ServerResource =>
  "dispose" in created && "server" in created
    ? created
    : { server: created as ConnectableServer, dispose: () => undefined };

/**
 * Start the Streamable HTTP server. Rejects on bad configuration (wildcard
 * bind, missing or short token, bad port) before it listens.
 */
export const createStreamableHttpServer = async (
  options: StreamableHttpOptions,
): Promise<StreamableHttpHandle> => {
  const config = resolveConfig(options);
  const path = options.path ?? "/mcp";
  const healthPath = options.healthPath ?? "/healthz";
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const idleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const stateless = options.stateless ?? false;

  const sessions = new Map<string, Session>();
  // Includes initializations in flight, so both capacity and shutdown cover them.
  const resources = new Set<Session>();
  let closing = false;

  // Idempotent and re-entrant: the promise is stored before any teardown runs, because
  // server.close() closes the transport, which calls back into dispose().
  const dispose = (session: Session): Promise<void> => {
    if (session.disposed) return session.disposed;
    let release!: () => void;
    session.disposed = new Promise<void>((resolve) => {
      release = resolve;
    });
    resources.delete(session);
    if (session.transport.sessionId) sessions.delete(session.transport.sessionId);
    // Both run inside a promise callback, so a hook that throws before returning
    // is settled like one that rejects, and the stored promise is always released.
    void Promise.allSettled([
      Promise.resolve().then(() => session.server.close()),
      Promise.resolve().then(() => session.dispose?.()),
    ]).then(() => release());
    return session.disposed;
  };

  // Slots reserved by sessions still being created, so concurrent initializations
  // cannot overshoot the cap while createServer is awaited.
  let pending = 0;
  const openWithinCap = async (): Promise<Session | undefined> => {
    if (resources.size + pending >= maxSessions) return undefined;
    pending += 1;
    try {
      return await open();
    } finally {
      pending -= 1;
    }
  };

  const open = async (): Promise<Session | undefined> => {
    const { server, dispose: extra } = unwrap(await options.createServer());
    // close() snapshots the resources, so one finished after that must be released here.
    if (closing) {
      await Promise.allSettled([
        Promise.resolve().then(() => server.close()),
        Promise.resolve().then(() => extra?.()),
      ]);
      return undefined;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: stateless ? undefined : randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
    });
    const session: Session = { server, dispose: extra, transport, lastUsed: Date.now(), active: 0 };
    resources.add(session);
    try {
      await server.connect(transport);
    } catch (error) {
      await dispose(session);
      throw error;
    }
    // close() may have started while connect was pending and already disposed this session.
    if (closing) {
      await dispose(session);
      return undefined;
    }
    // connect installs its own onclose. Keep the SDK cleanup as well as ours. A client
    // DELETE closes the transport without going through close() or the reaper, so the
    // custom dispose hook has to run from here too.
    const onclose = transport.onclose;
    transport.onclose = () => {
      void dispose(session);
      onclose?.();
    };
    return session;
  };

  // While shutting down, drop the connection after the answer so close() is not held
  // open by a keep-alive socket that went idle after its sweep.
  const unavailable = (response: ServerResponse): void =>
    sendJson(response, 503, { error: "Service unavailable" }, closing ? { connection: "close" } : {});

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (closing) return unavailable(response);
    if (
      !matchesHost(request.headers.host, config.allowedHosts) ||
      !matchesOrigin(request.headers.origin, config.allowedOrigins)
    ) {
      return sendJson(response, 403, { error: "Forbidden" });
    }
    const target = originFormPath(request.url);
    if (target === undefined) return sendJson(response, 400, { error: "Bad request" });
    if (request.method === "GET" && target === healthPath) {
      return sendJson(response, 200, { status: "ok" });
    }
    if (target !== path) return sendJson(response, 404, { error: "Not found" });

    if (config.token !== "" && !secretsEqual(bearerOf(request.headers.authorization), config.token)) {
      return sendJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
    }
    const allowed = stateless ? ["POST"] : ["GET", "POST", "DELETE"];
    if (!allowed.includes(request.method ?? "")) {
      return sendJson(response, 405, { error: "Method not allowed" }, { allow: allowed.join(", ") });
    }
    const body = request.method === "POST" ? await readJsonBody(request, maxBody) : undefined;
    // close() snapshots the resources; one created after that would never be disposed.
    if (closing) return unavailable(response);

    if (stateless) {
      const session = await openWithinCap();
      if (!session) return unavailable(response);
      const finish = (): void => void dispose(session);
      response.once("close", finish);
      session.active += 1;
      try {
        await session.transport.handleRequest(request, response, body);
      } catch (error) {
        await dispose(session);
        throw error;
      } finally {
        session.active -= 1;
      }
      return;
    }

    const id = request.headers["mcp-session-id"];
    let session = typeof id === "string" ? sessions.get(id) : undefined;
    if (id !== undefined && !session) return sendJson(response, 404, { error: "Session not found" });
    let created = false;
    if (!session) {
      if (request.method !== "POST" || !isInitializeRequest(body)) {
        return sendJson(response, 400, { error: "Initialize a session first" });
      }
      session = await openWithinCap();
      if (!session) return unavailable(response);
      created = true;
    }
    session.lastUsed = Date.now();
    const activeCall = request.method === "POST";
    if (activeCall) session.active += 1;
    try {
      await session.transport.handleRequest(request, response, body);
    } finally {
      if (activeCall) session.active -= 1;
      session.lastUsed = Date.now();
      if (created && !session.transport.sessionId) await dispose(session);
    }
  };

  const listener: NodeHttpServer = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (error instanceof RequestError) {
        sendJson(response, error.status, { error: error.message });
      } else {
        sendRpcError(response, 500, "Internal server error");
      }
    });
  });
  listener.requestTimeout = 30_000;
  listener.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(config.port, config.host, () => {
      listener.off("error", reject);
      resolve();
    });
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP listener did not bind a TCP port");
  }

  const reaper = setInterval(() => {
    for (const session of resources) {
      if (session.active === 0 && Date.now() - session.lastUsed > idleMs) {
        void dispose(session).catch(() => undefined);
      }
    }
  }, Math.min(60_000, Math.max(10, idleMs)));
  reaper.unref();

  const boundHost = address.address.includes(":") ? `[${address.address}]` : address.address;
  // A configured DNS name resolves to this address, and the URL handed back uses the address.
  config.allowedHosts.push({ hostname: boundHost.toLowerCase(), port: undefined });
  let closePromise: Promise<void> | undefined;
  return {
    host: address.address,
    port: address.port,
    url: `http://${boundHost}:${address.port}${path}`,
    close() {
      closePromise ??= (async () => {
        closing = true;
        clearInterval(reaper);
        const stopped = new Promise<void>((resolve, reject) => {
          listener.close((error) => (error ? reject(error) : resolve()));
        });
        let deadlineHit = false;
        const deadline = setTimeout(() => {
          deadlineHit = true;
          listener.closeAllConnections();
        }, 5_000);
        deadline.unref();
        try {
          // Let calls already running finish before their server and resources are torn down.
          while ([...resources].some((session) => session.active > 0) && !deadlineHit) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await Promise.allSettled([...resources].map(dispose));
          listener.closeIdleConnections();
          await stopped;
        } finally {
          clearTimeout(deadline);
        }
      })();
      return closePromise;
    },
  };
};

/**
 * Start the server for a `*-http` bin: log the URL to stderr and close
 * gracefully on SIGINT and SIGTERM. Never logs the token.
 */
export const runStreamableHttpServer = async (
  options: StreamableHttpOptions,
): Promise<StreamableHttpHandle> => {
  const handle = await createStreamableHttpServer(options);
  console.error(`${options.name ?? "mcp"} HTTP listening on ${handle.url}`);
  const shutdown = (): void => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    void handle.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return handle;
};
