import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { sendRequest, type HttpContext } from "../src/http.js";

const servers: Server[] = [];
const serve = async (listener: RequestListener): Promise<URL> => {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return new URL(`http://127.0.0.1:${address.port}/`);
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

const context = (baseUrl: URL, options: Partial<HttpContext> = {}): HttpContext => ({
  baseUrl, timeoutMs: 1000, ...options,
});
const request = { method: "GET", path: "start", responseType: "text" } as const;

describe("HTTP redirect policy", () => {
  it("rejects redirects by default before forwarding custom authentication", async () => {
    let destinationCalls = 0;
    const destination = await serve((_req, res) => {
      destinationCalls += 1;
      res.end("unexpected");
    });
    const baseUrl = await serve((_req, res) => {
      res.writeHead(302, { location: destination.href });
      res.end();
    });
    const result = await Effect.runPromise(Effect.either(sendRequest(context(baseUrl, {
      auth: { apply: (headers) => Effect.sync(() => {
        headers.set("x-custom-auth", "test-marker");
        return headers;
      }) },
    }), request)));
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "TransportError" } });
    expect(destinationCalls).toBe(0);
  });

  it("allows explicit same-origin redirects and preserves header override precedence", async () => {
    let seen: string | undefined;
    const baseUrl = await serve((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/end" });
      } else {
        seen = String(req.headers["x-custom-auth"]);
      }
      res.end("done");
    });
    const result = await Effect.runPromise(sendRequest(context(baseUrl, {
      defaultHeaders: { "x-custom-auth": "default" },
      auth: { apply: (headers) => Effect.succeed(new Headers({ ...Object.fromEntries(headers), "x-custom-auth": "strategy" })) },
    }), { ...request, redirect: "same-origin", headers: { "x-custom-auth": "request" } }));
    expect(result.body).toBe("done");
    expect(seen).toBe("request");
  });

  it("blocks an origin change later in an explicitly allowed redirect chain", async () => {
    let destinationCalls = 0;
    const destination = await serve((_req, res) => {
      destinationCalls += 1;
      res.end("unexpected");
    });
    const baseUrl = await serve((req, res) => {
      res.writeHead(307, { location: req.url === "/start" ? "/middle" : destination.href });
      res.end();
    });
    const result = await Effect.runPromise(Effect.either(sendRequest(context(baseUrl, {
      redirect: "same-origin", defaultHeaders: { "x-custom-auth": "test-marker" },
    }), request)));
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "TransportError" } });
    expect(destinationCalls).toBe(0);
  });

  it("lets a request disable a context's same-origin redirects", async () => {
    let calls = 0;
    const baseUrl = await serve((_req, res) => {
      calls += 1;
      res.writeHead(302, { location: "/end" });
      res.end();
    });
    const result = await Effect.runPromise(Effect.either(sendRequest(context(baseUrl, {
      redirect: "same-origin",
    }), { ...request, redirect: "error" })));
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "TransportError" } });
    expect(calls).toBe(1);
  });

  it("rejects URL userinfo before following an allowed same-origin redirect", async () => {
    let calls = 0;
    const baseUrl = await serve((_req, res) => {
      calls += 1;
      const target = new URL("end", baseUrl);
      target.username = "fixture";
      res.writeHead(302, { location: target.href });
      res.end();
    });
    const result = await Effect.runPromise(Effect.either(sendRequest(context(baseUrl, {
      redirect: "same-origin",
    }), request)));
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "TransportError" } });
    expect(calls).toBe(1);
  });

  it.each([301, 302, 303, 307, 308])("preserves fetch POST/body semantics for same-origin %i", async (status) => {
    let received: { method?: string; body: string; contentType?: string } | undefined;
    const baseUrl = await serve((req, res) => {
      if (req.url === "/start") {
        res.writeHead(status, { location: "/end" });
        res.end();
      } else {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          received = { method: req.method, body, contentType: req.headers["content-type"] };
          res.end("done");
        });
      }
    });
    await Effect.runPromise(sendRequest(context(baseUrl, { redirect: "same-origin" }), {
      ...request, method: "POST", body: "payload", bodyEncoding: "text",
    }));
    expect(received).toEqual(status === 307 || status === 308
      ? { method: "POST", body: "payload", contentType: "text/plain" }
      : { method: "GET", body: "", contentType: undefined });
  });

  it("bounds redirect loops", async () => {
    let calls = 0;
    const baseUrl = await serve((_req, res) => {
      calls += 1;
      res.writeHead(302, { location: "/start" });
      res.end();
    });
    const result = await Effect.runPromise(Effect.either(sendRequest(context(baseUrl, { redirect: "same-origin" }), request)));
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "TransportError" } });
    expect(calls).toBe(11);
  });
});
