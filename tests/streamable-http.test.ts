// The tokens below are generated fixtures for this test file, not credentials.
// content-guard: allow secret/bearer-token file
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { hostname as osHostname } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
  DEFAULT_MAX_BODY_BYTES,
  createStreamableHttpServer,
  isLoopbackHost,
  secretsEqual,
  type StreamableHttpHandle,
  type StreamableHttpOptions,
} from "../src/streamable-http.js";

const TOKEN = "t".repeat(32);

const makeServer = (): McpServer => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.tool("echo", "Echo text", { text: z.string() }, async ({ text }) => ({
    content: [{ type: "text", text }],
  }));
  return server;
};

const started: StreamableHttpHandle[] = [];

const start = async (
  overrides: Partial<StreamableHttpOptions> = {},
): Promise<StreamableHttpHandle> => {
  const handle = await createStreamableHttpServer({
    createServer: makeServer,
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    ...overrides,
  });
  started.push(handle);
  return handle;
};

afterEach(async () => {
  await Promise.all(started.splice(0).map((handle) => handle.close()));
});

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const raw = (
  handle: StreamableHttpHandle,
  init: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    address?: string;
  } = {},
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: init.address ?? "127.0.0.1",
        port: handle.port,
        method: init.method ?? "GET",
        path: init.path ?? "/mcp",
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });

const auth = { authorization: `Bearer ${TOKEN}` };
const jsonHeaders = {
  ...auth,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});

describe("configuration", () => {
  it("binds loopback by default", async () => {
    const handle = await createStreamableHttpServer({ createServer: makeServer, port: 0 });
    started.push(handle);
    expect(handle.host).toBe("127.0.0.1");
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/mcp`);
  });

  it.each(["0.0.0.0", "::", "[::]", ""])("refuses the wildcard bind %j", async (host) => {
    await expect(
      createStreamableHttpServer({ createServer: makeServer, host, port: 0, token: TOKEN }),
    ).rejects.toThrow(/not a wildcard|specific address/);
  });

  it("requires a token on a non-loopback bind", async () => {
    await expect(
      createStreamableHttpServer({ createServer: makeServer, host: "192.0.2.10", port: 0 }),
    ).rejects.toThrow(/TOKEN|token/);
  });

  it("allows no token on loopback and then does not demand a bearer", async () => {
    const handle = await start({ token: undefined });
    const res = await raw(handle, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: initializeBody,
    });
    expect(res.status).toBe(200);
  });

  it("rejects a token shorter than 32 characters even on loopback", async () => {
    await expect(
      createStreamableHttpServer({ createServer: makeServer, port: 0, token: "short" }),
    ).rejects.toThrow(/at least 32 characters/);
  });

  it("rejects a token equal to an upstream credential", async () => {
    await expect(
      createStreamableHttpServer({
        createServer: makeServer,
        port: 0,
        token: TOKEN,
        distinctFrom: ["other", TOKEN],
      }),
    ).rejects.toThrow(/must differ from the upstream credentials/);
  });

  it("reads each app's existing environment variable names from a prefix", async () => {
    const handle = await createStreamableHttpServer({
      createServer: makeServer,
      envPrefix: "APP_MCP_HTTP",
      env: { APP_MCP_HTTP_TOKEN: TOKEN, APP_MCP_HTTP_PORT: "0", APP_MCP_HTTP_HOST: "127.0.0.1" },
    });
    started.push(handle);
    const res = await raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    expect(res.status).toBe(200);
  });

  it("names the prefixed variable in errors", async () => {
    await expect(
      createStreamableHttpServer({
        createServer: makeServer,
        envPrefix: "APP_MCP_HTTP",
        env: { APP_MCP_HTTP_HOST: "0.0.0.0", APP_MCP_HTTP_TOKEN: TOKEN },
      }),
    ).rejects.toThrow(/APP_MCP_HTTP_HOST/);
    await expect(
      createStreamableHttpServer({
        createServer: makeServer,
        envPrefix: "APP_MCP_HTTP",
        env: { APP_MCP_HTTP_PORT: "70000" },
      }),
    ).rejects.toThrow(/APP_MCP_HTTP_PORT must be an integer/);
    await expect(
      createStreamableHttpServer({
        createServer: makeServer,
        envPrefix: "APP_MCP_HTTP",
        env: { APP_MCP_HTTP_TOKEN: "x" },
      }),
    ).rejects.toThrow(/APP_MCP_HTTP_TOKEN must be at least 32/);
  });

  it("uses the default port when none is set", async () => {
    await expect(
      createStreamableHttpServer({ createServer: makeServer, env: {}, defaultPort: 70000 }),
    ).rejects.toThrow(/integer from 0 to 65535/);
  });

  it("rejects malformed allowed hosts and origins", async () => {
    await expect(
      createStreamableHttpServer({ createServer: makeServer, port: 0, allowedHosts: ["a b"] }),
    ).rejects.toThrow(/invalid entry/);
    await expect(
      createStreamableHttpServer({
        createServer: makeServer,
        port: 0,
        allowedOrigins: ["https://host/path"],
      }),
    ).rejects.toThrow(/exact origins/);
  });
});

describe("helpers", () => {
  it.each(["localhost", "127.0.0.1", "127.9.9.9", "::1", "[::1]", "::ffff:127.0.0.1"])(
    "treats %s as loopback",
    (host) => expect(isLoopbackHost(host)).toBe(true),
  );

  it.each(["192.0.2.10", "example.com", "0.0.0.0", "::", "10.0.0.1"])(
    "does not treat %s as loopback",
    (host) => expect(isLoopbackHost(host)).toBe(false),
  );

  it("compares secrets without leaking length", () => {
    expect(secretsEqual("a", "a")).toBe(true);
    expect(secretsEqual("a", "ab")).toBe(false);
    expect(secretsEqual("", "x")).toBe(false);
  });
});

describe("authentication", () => {
  it("answers 401 with a challenge for a missing, wrong or malformed bearer", async () => {
    const handle = await start();
    for (const headers of [
      {},
      { authorization: "Bearer wrong" },
      { authorization: TOKEN },
      { authorization: `Basic ${TOKEN}` },
    ]) {
      const res = await raw(handle, { method: "POST", headers, body: "{}" });
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
    }
  });

  it("serves the health path without a token", async () => {
    const handle = await start();
    const res = await raw(handle, { path: "/healthz" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("answers 404 for other paths", async () => {
    const handle = await start();
    expect((await raw(handle, { path: "/other", headers: auth })).status).toBe(404);
  });

  it("answers 400 for a non origin-form request target", async () => {
    const handle = await start();
    expect((await raw(handle, { path: "//evil.example/mcp", headers: auth })).status).toBe(400);
  });

  it("answers 405 for an unsupported method", async () => {
    const handle = await start();
    const res = await raw(handle, { method: "PUT", headers: auth });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, POST, DELETE");
  });
});

describe("Host and Origin checks", () => {
  const post = (handle: StreamableHttpHandle, headers: Record<string, string>) =>
    raw(handle, { method: "POST", headers: { ...jsonHeaders, ...headers }, body: initializeBody });

  it("accepts loopback Host values and the bound address", async () => {
    const handle = await start();
    for (const host of [`127.0.0.1:${handle.port}`, `localhost:${handle.port}`, `[::1]:${handle.port}`]) {
      expect((await post(handle, { host })).status, host).toBe(200);
    }
  });

  it("accepts the address in the returned url when bound by a DNS name", async () => {
    const name = osHostname();
    let address: string;
    try {
      address = (await lookup(name, { family: 4 })).address;
    } catch {
      return; // the machine name does not resolve here, so there is nothing to bind by name
    }
    const handle = await start({ host: name });
    const url = new URL(handle.url);
    expect(url.hostname).toBe(address);
    const res = await raw(handle, { path: "/healthz", address, headers: { host: url.host } });
    expect(res.status).toBe(200);
  });

  it("rejects a Host that is not loopback, bound or allowed (DNS rebinding)", async () => {
    const handle = await start();
    for (const host of ["evil.example", "evil.example:80", "127.0.0.1@evil.example", "127.0.0.1/x", "127.1"]) {
      expect((await post(handle, { host })).status, host).toBe(403);
    }
  });

  it("accepts an explicitly allowed Host, by name or by name and port", async () => {
    const byName = await start({ allowedHosts: ["mcp.example.com"] });
    expect((await post(byName, { host: "mcp.example.com" })).status).toBe(200);
    expect((await post(byName, { host: "mcp.example.com:8443" })).status).toBe(200);
    const byPort = await start({ allowedHosts: ["mcp.example.com:8443"] });
    expect((await post(byPort, { host: "mcp.example.com:8443" })).status).toBe(200);
    expect((await post(byPort, { host: "mcp.example.com:9" })).status).toBe(403);
    expect((await post(byPort, { host: "mcp.example.com" })).status).toBe(403);
  });

  it("takes extra hosts and origins from the prefixed environment", async () => {
    const handle = await createStreamableHttpServer({
      createServer: makeServer,
      envPrefix: "APP_HTTP",
      env: {
        APP_HTTP_TOKEN: TOKEN,
        APP_HTTP_PORT: "0",
        APP_HTTP_ALLOWED_HOSTS: "a.example, b.example",
        APP_HTTP_ALLOWED_ORIGINS: "https://a.example",
      },
    });
    started.push(handle);
    expect((await post(handle, { host: "b.example", origin: "https://a.example" })).status).toBe(200);
  });

  it("allows a missing Origin and loopback origins, rejects the rest", async () => {
    const handle = await start();
    expect((await post(handle, {})).status).toBe(200);
    expect((await post(handle, { origin: "http://localhost:3000" })).status).toBe(200);
    for (const origin of ["https://evil.example", "null", "http://localhost:3000/", "file://x", "not a url"]) {
      expect((await post(handle, { origin })).status, origin).toBe(403);
    }
  });

  it("accepts an explicitly allowed Origin", async () => {
    const handle = await start({ allowedOrigins: ["https://app.example.com"] });
    expect((await post(handle, { origin: "https://app.example.com" })).status).toBe(200);
    expect((await post(handle, { origin: "https://other.example.com" })).status).toBe(403);
  });

  it("checks Host and Origin before the token", async () => {
    const handle = await start();
    const res = await raw(handle, { method: "POST", headers: { host: "evil.example" }, body: "{}" });
    expect(res.status).toBe(403);
  });
});

describe("request body", () => {
  it("answers 413 for a Content-Length over the cap", async () => {
    const handle = await start({ maxBodyBytes: 1024 });
    const res = await raw(handle, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ pad: "x".repeat(2048) }),
    });
    expect(res.status).toBe(413);
  });

  it("answers 413 for an oversized body without trusting Content-Length", async () => {
    const handle = await start({ maxBodyBytes: 1024 });
    const res = await raw(handle, {
      method: "POST",
      headers: { ...jsonHeaders, "transfer-encoding": "chunked" },
      body: JSON.stringify({ pad: "x".repeat(4096) }),
    });
    expect(res.status).toBe(413);
  });

  it("answers 400 for a malformed Content-Length and for invalid JSON", async () => {
    const handle = await start();
    expect(
      (await raw(handle, { method: "POST", headers: { ...jsonHeaders, "content-length": "1e9" }, body: "{}" }))
        .status,
    ).toBe(400);
    expect((await raw(handle, { method: "POST", headers: jsonHeaders, body: "{nope" })).status).toBe(400);
  });

  it("defaults the cap to 1 MiB", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(1_048_576);
  });
});

const sessionIdOf = (response: RawResponse): string => response.headers["mcp-session-id"] as string;

describe("sessions", () => {
  it("serves a full MCP exchange through the SDK client", async () => {
    const handle = await start();
    const client = new Client({ name: "c", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(handle.url), {
        requestInit: { headers: auth },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["echo"]);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    await client.close();
  });

  it("requires an initialize before any other request", async () => {
    const handle = await start();
    const res = await raw(handle, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });

  it("answers 404 for an unknown session id", async () => {
    const handle = await start();
    const res = await raw(handle, {
      method: "POST",
      headers: { ...jsonHeaders, "mcp-session-id": "nope" },
      body: initializeBody,
    });
    expect(res.status).toBe(404);
  });

  it("caps concurrent sessions and frees a slot on DELETE", async () => {
    const handle = await start({ maxSessions: 1 });
    const first = await raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    expect(first.status).toBe(200);
    const sessionId = first.headers["mcp-session-id"] as string;
    expect(sessionId).toBeTruthy();

    const second = await raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    expect(second.status).toBe(503);

    const del = await raw(handle, { method: "DELETE", headers: { ...auth, "mcp-session-id": sessionId } });
    expect(del.status).toBe(200);
    // The slot is freed once the transport close callback runs.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = await raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    expect(third.status).toBe(200);
  });

  it("does not exceed the cap under concurrent initializations", async () => {
    const handle = await start({
      maxSessions: 2,
      createServer: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return makeServer();
      },
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 503)).toHaveLength(4);
  });

  it("reaps idle sessions", async () => {
    let closed = 0;
    const handle = await start({
      sessionIdleMs: 30,
      createServer: () => {
        const server = makeServer();
        return { server, dispose: () => void (closed += 1) };
      },
    });
    const res = await raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    const sessionId = res.headers["mcp-session-id"] as string;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(closed).toBe(1);
    const after = await raw(handle, {
      method: "POST",
      headers: { ...jsonHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    expect(after.status).toBe(404);
  });

  it("disposes open sessions on close and then refuses requests", async () => {
    let disposed = 0;
    const handle = await createStreamableHttpServer({
      createServer: () => ({ server: makeServer(), dispose: () => void (disposed += 1) }),
      port: 0,
      token: TOKEN,
    });
    await raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    await handle.close();
    expect(disposed).toBe(1);
    await expect(raw(handle, { path: "/healthz" })).rejects.toThrow();
  });

  it("runs the custom dispose hook when a client ends its session with DELETE", async () => {
    let disposed = 0;
    const handle = await start({
      createServer: () => ({ server: makeServer(), dispose: () => void (disposed += 1) }),
    });
    const res = await raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    const sessionId = res.headers["mcp-session-id"] as string;
    const del = await raw(handle, {
      method: "DELETE",
      headers: { ...auth, "mcp-session-id": sessionId },
    });
    expect(del.status).toBeLessThan(300);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(disposed).toBe(1);
    // The session is gone, and a later close() does not dispose it a second time.
    await handle.close();
    expect(disposed).toBe(1);
  });

  it("runs the custom dispose hook when the SDK client closes", async () => {
    let disposed = 0;
    const handle = await start({
      createServer: () => ({ server: makeServer(), dispose: () => void (disposed += 1) }),
    });
    const client = new Client({ name: "c", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: auth },
    });
    await client.connect(transport);
    await transport.terminateSession();
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(disposed).toBe(1);
  });

  it("disposes a session whose factory finishes after close() began", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const factoryEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let disposed = 0;
    const handle = await createStreamableHttpServer({
      createServer: async () => {
        entered();
        await gate;
        return { server: makeServer(), dispose: () => void (disposed += 1) };
      },
      port: 0,
      token: TOKEN,
    });
    const pendingInit = raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    await factoryEntered;
    const closing = handle.close();
    release();
    const res = await pendingInit;
    await closing;
    expect(res.status).toBe(503);
    expect(disposed).toBe(1);
  });

  it("still disposes and closes when server.close() throws synchronously", async () => {
    let disposed = 0;
    const handle = await createStreamableHttpServer({
      createServer: () => {
        const server = makeServer();
        server.close = (() => {
          throw new Error("close failed");
        }) as never;
        return { server, dispose: () => void (disposed += 1) };
      },
      port: 0,
      token: TOKEN,
    });
    await raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    await expect(handle.close()).resolves.toBeUndefined();
    expect(disposed).toBe(1);
  });

  it("answers 503 for a session whose connect finishes after close() began", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const connectEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let disposed = 0;
    const handle = await createStreamableHttpServer({
      createServer: () => {
        const server = makeServer();
        const connect = server.connect.bind(server);
        server.connect = (async (transport: never) => {
          entered();
          await gate;
          return connect(transport);
        }) as never;
        return { server, dispose: () => void (disposed += 1) };
      },
      port: 0,
      token: TOKEN,
    });
    const pendingInit = raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    await connectEntered;
    const closing = handle.close();
    release();
    const res = await pendingInit;
    await closing;
    expect(res.status).toBe(503);
    expect(disposed).toBe(1);
  });

  it("lets a running call finish before disposing its session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const events: string[] = [];
    const handle = await createStreamableHttpServer({
      createServer: () => {
        const server = new McpServer({ name: "test", version: "0.0.0" });
        server.tool("slow", "Wait", {}, async () => {
          started();
          await gate;
          events.push("tool-finished");
          return { content: [{ type: "text", text: "done" }] };
        });
        return { server, dispose: () => void events.push("disposed") };
      },
      port: 0,
      token: TOKEN,
    });
    const init = await raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    const sessionId = sessionIdOf(init);
    const call = raw(handle, {
      method: "POST",
      headers: { ...jsonHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow", arguments: {} } }),
    });
    await toolStarted;
    const closing = handle.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual([]);
    release();
    const result = await call;
    await closing;
    expect(result.status).toBe(200);
    expect(result.body).toContain("done");
    expect(events).toEqual(["tool-finished", "disposed"]);
  });

  it("close is idempotent", async () => {
    const handle = await createStreamableHttpServer({ createServer: makeServer, port: 0 });
    await Promise.all([handle.close(), handle.close()]);
  });

  it("answers 500 without leaking the error when the factory throws", async () => {
    const handle = await start({
      createServer: () => {
        throw new Error("secret-detail");
      },
    });
    const res = await raw(handle, { method: "POST", headers: jsonHeaders, body: initializeBody });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain("secret-detail");
  });
});

describe("stateless mode", () => {
  it("serves a request with a fresh server each time and no session id", async () => {
    let created = 0;
    const handle = await start({
      stateless: true,
      createServer: () => {
        created += 1;
        return makeServer();
      },
    });
    const call = () =>
      raw(handle, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const first = await call();
    const second = await call();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers["mcp-session-id"]).toBeUndefined();
    expect(created).toBe(2);
    expect(JSON.parse(first.body).result.tools[0].name).toBe("echo");
  });

  it("answers 405 to GET and DELETE", async () => {
    const handle = await start({ stateless: true });
    for (const method of ["GET", "DELETE"]) {
      const res = await raw(handle, { method, headers: auth });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("POST");
    }
  });
});
