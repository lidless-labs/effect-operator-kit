import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Exit, Cause } from "effect";
import {
  buildUrl,
  sendRequest,
  type HttpContext,
  type HttpRequest,
} from "../src/http.js";
import {
  AuthError,
  ForbiddenError,
  NotFoundError,
  TimeoutError,
  TransportError,
  ParseError,
  UnexpectedStatusError,
} from "../src/errors.js";

const baseUrl = new URL("https://api.example.com/v1/");

function makeCtx(overrides: Partial<HttpContext> = {}): HttpContext {
  return {
    baseUrl,
    timeoutMs: 5000,
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  init: ResponseInit = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

async function expectFailure<A>(
  effect: Effect.Effect<A, unknown>,
): Promise<unknown> {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    return Cause.squash(exit.cause);
  }
  throw new Error("expected failure");
}

describe("buildUrl", () => {
  it("appends a relative path to the base URL", () => {
    const url = buildUrl(baseUrl, "users");
    expect(url.href).toBe("https://api.example.com/v1/users");
  });

  it("replaces pathname when path starts with /", () => {
    const url = buildUrl(baseUrl, "/users");
    expect(url.href).toBe("https://api.example.com/users");
  });

  it("serializes scalar query parameters", () => {
    const url = buildUrl(baseUrl, "items", { page: 2, active: true });
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("active")).toBe("true");
  });

  it("omits null and undefined query values", () => {
    const url = buildUrl(baseUrl, "items", {
      keep: "yes",
      skip: null,
      missing: undefined,
    });
    expect(url.searchParams.get("keep")).toBe("yes");
    expect(url.searchParams.has("skip")).toBe(false);
    expect(url.searchParams.has("missing")).toBe(false);
  });

  it("repeats keys for array query values", () => {
    const url = buildUrl(baseUrl, "items", { tags: ["a", "b"] });
    expect(url.searchParams.getAll("tags")).toEqual(["a", "b"]);
  });

  it("rejects absolute http(s) paths that would change origin", () => {
    expect(() => buildUrl(baseUrl, "https://evil.com/steal")).toThrow(TypeError);
    expect(() => buildUrl(baseUrl, "https://evil.com/steal")).toThrow(
      /origin/i,
    );
  });

  it("rejects protocol-relative paths that would change origin", () => {
    expect(() => buildUrl(baseUrl, "//evil.com/steal")).toThrow(TypeError);
    expect(() => buildUrl(baseUrl, "//evil.com/steal")).toThrow(/origin/i);
  });

  it("keeps normal relative paths on the base origin", () => {
    const url = buildUrl(baseUrl, "users/1");
    expect(url.origin).toBe(baseUrl.origin);
    expect(url.href).toBe("https://api.example.com/v1/users/1");
  });
});

describe("sendRequest", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("happy path", () => {
    it("returns parsed JSON for a 200 response", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));

      const result = await Effect.runPromise(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "GET",
          path: "users/1",
        }),
      );

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ id: 1 });
      expect(result.bodyText).toBe('{"id":1}');
      expect(result.headers).toBeInstanceOf(Headers);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns text body when responseType is text", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("plain text", { status: 200 }),
      );

      const result = await Effect.runPromise(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "GET",
          path: "raw",
          responseType: "text",
        }),
      );

      expect(result.body).toBe("plain text");
      expect(result.bodyText).toBe("plain text");
    });

    it("skips parsing when responseType is none", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('{"ignored":true}', { status: 200 }),
      );

      const result = await Effect.runPromise(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "GET",
          path: "noop",
          responseType: "none",
        }),
      );

      expect(result.body).toBeUndefined();
      expect(result.bodyText).toBe('{"ignored":true}');
    });

    it("accepts only statuses listed in expectedStatuses", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ created: true }, 201));

      await expectFailure(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "POST",
          path: "items",
          expectedStatuses: [200],
        }),
      );

      fetchMock.mockResolvedValueOnce(jsonResponse({ created: true }, 201));

      const result = await Effect.runPromise(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "POST",
          path: "items",
          expectedStatuses: [201],
        }),
      );

      expect(result.status).toBe(201);
    });

    it("uses per-request timeoutMs in TimeoutError", async () => {
      fetchMock.mockImplementation((_url, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      });

      vi.useFakeTimers();

      const effect = sendRequest(makeCtx({ fetch: fetchMock, timeoutMs: 5000 }), {
        method: "GET",
        path: "slow",
        timeoutMs: 42,
      });

      const run = Effect.runPromiseExit(effect);
      await vi.advanceTimersByTimeAsync(50);
      const exit = await run;
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

      expect(error).toMatchObject({
        _tag: "TimeoutError",
        method: "GET",
        path: "slow",
        timeoutMs: 42,
      });
    });
  });

  describe("body encodings", () => {
    it("serializes JSON bodies and sets Content-Type", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await Effect.runPromise(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "POST",
          path: "items",
          body: { name: "widget" },
          bodyEncoding: "json",
        }),
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe('{"name":"widget"}');
      const headers = new Headers(init.headers);
      expect(headers.get("content-type")).toBe("application/json");
    });

    it("sends raw text bodies", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await Effect.runPromise(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "POST",
          path: "items",
          body: "hello",
          bodyEncoding: "text",
        }),
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe("hello");
      const headers = new Headers(init.headers);
      expect(headers.get("content-type")).toBe("text/plain");
    });

    it("serializes form bodies as application/x-www-form-urlencoded", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await Effect.runPromise(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "POST",
          path: "items",
          body: { a: "1", b: "2" },
          bodyEncoding: "form",
        }),
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe("a=1&b=2");
      const headers = new Headers(init.headers);
      expect(headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
    });

    it("omits a body when encoding is none", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await Effect.runPromise(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "GET",
          path: "items",
          bodyEncoding: "none",
        }),
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBeUndefined();
    });

    it("does not overwrite caller-provided Content-Type", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await Effect.runPromise(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "POST",
          path: "items",
          body: { x: 1 },
          bodyEncoding: "json",
          headers: { "content-type": "application/vnd.custom+json" },
        }),
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("content-type")).toBe(
        "application/vnd.custom+json",
      );
    });
  });

  describe("auth and headers", () => {
    it("applies AuthStrategy headers", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await Effect.runPromise(
        sendRequest(
          makeCtx({
            fetch: fetchMock,
            auth: {
              apply: (headers) =>
                Effect.sync(() => {
                  const next = new Headers(headers);
                  next.set("Authorization", "Bearer secret-token");
                  return next;
                }),
            },
          }),
          { method: "GET", path: "secure" },
        ),
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer secret-token");
    });

    it("merges defaultHeaders, auth, and request headers with later wins", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await Effect.runPromise(
        sendRequest(
          makeCtx({
            fetch: fetchMock,
            defaultHeaders: { "X-Default": "1", "X-Shared": "default" },
            auth: {
              apply: (headers) =>
                Effect.sync(() => {
                  const next = new Headers(headers);
                  next.set("X-Auth", "yes");
                  next.set("X-Shared", "auth");
                  return next;
                }),
            },
          }),
          {
            method: "GET",
            path: "merge",
            headers: { "X-Request": "req", "X-Shared": "request" },
          },
        ),
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("x-default")).toBe("1");
      expect(headers.get("x-auth")).toBe("yes");
      expect(headers.get("x-request")).toBe("req");
      expect(headers.get("x-shared")).toBe("request");
    });
  });

  describe("default status mapping", () => {
    const req = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
      method: "GET",
      path: "resource",
      ...overrides,
    });

    it("maps 401 to AuthError", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("unauthorized", { status: 401 }),
      );

      const error = await expectFailure(
        sendRequest(makeCtx({ fetch: fetchMock }), req()),
      );

      expect(error).toBeInstanceOf(AuthError);
      expect(error).toMatchObject({
        _tag: "AuthError",
        method: "GET",
        path: "resource",
        status: 401,
      });
    });

    it("maps 403 to ForbiddenError", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("forbidden", { status: 403 }),
      );

      const error = await expectFailure(
        sendRequest(makeCtx({ fetch: fetchMock }), req()),
      );

      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error).toMatchObject({
        _tag: "ForbiddenError",
        method: "GET",
        path: "resource",
        status: 403,
      });
    });

    it("maps 404 to NotFoundError", async () => {
      fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));

      const error = await expectFailure(
        sendRequest(makeCtx({ fetch: fetchMock }), req()),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({
        _tag: "NotFoundError",
        method: "GET",
        path: "resource",
        status: 404,
      });
    });

    it("maps other unexpected statuses to UnexpectedStatusError", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("boom", { status: 500 }),
      );

      const error = await expectFailure(
        sendRequest(makeCtx({ fetch: fetchMock }), req()),
      );

      expect(error).toBeInstanceOf(UnexpectedStatusError);
      expect(error).toMatchObject({
        _tag: "UnexpectedStatusError",
        method: "GET",
        path: "resource",
        status: 500,
        body: "boom",
      });
    });

    it("maps invalid JSON to ParseError", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("not-json", { status: 200 }),
      );

      const error = await expectFailure(
        sendRequest(makeCtx({ fetch: fetchMock }), req()),
      );

      expect(error).toBeInstanceOf(ParseError);
      expect(error).toMatchObject({
        _tag: "ParseError",
        path: "resource",
      });
    });

    it("maps fetch rejections to TransportError", async () => {
      const cause = new TypeError("fetch failed");
      fetchMock.mockRejectedValueOnce(cause);

      const error = await expectFailure(
        sendRequest(makeCtx({ fetch: fetchMock }), req()),
      );

      expect(error).toBeInstanceOf(TransportError);
      expect(error).toMatchObject({
        _tag: "TransportError",
        method: "GET",
        path: "resource",
        cause,
      });
    });

    it("maps AbortError to TimeoutError", async () => {
      fetchMock.mockImplementation((_url, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      });

      vi.useFakeTimers();

      const effect = sendRequest(makeCtx({ fetch: fetchMock }), req());
      const run = Effect.runPromiseExit(effect);
      await vi.advanceTimersByTimeAsync(6000);
      const exit = await run;
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

      expect(error).toBeInstanceOf(TimeoutError);
      expect(error).toMatchObject({
        _tag: "TimeoutError",
        method: "GET",
        path: "resource",
        timeoutMs: 5000,
      });
    });

    it("uses injectable fetch from HttpContext", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      const globalFetch = vi.fn();

      await Effect.runPromise(
        sendRequest(
          makeCtx({ fetch: fetchMock }),
          { method: "GET", path: "items" },
        ),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
    });
  });

  describe("statusMapper override", () => {
    it("returns a custom OperatorError when mapper does not return null", async () => {
      fetchMock.mockResolvedValueOnce(new Response("teapot", { status: 418 }));

      const error = await expectFailure(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "GET",
          path: "tea",
          statusMapper: ({ status, method, path }) =>
            new ForbiddenError({
              method,
              path,
              status,
              body: "custom",
            }),
        }),
      );

      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error).toMatchObject({
        _tag: "ForbiddenError",
        status: 418,
        path: "tea",
      });
    });

    it("falls back to default mapping when mapper returns null", async () => {
      fetchMock.mockResolvedValueOnce(new Response("teapot", { status: 418 }));

      const error = await expectFailure(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "GET",
          path: "tea",
          statusMapper: () => null,
        }),
      );

      expect(error).toBeInstanceOf(UnexpectedStatusError);
      expect(error).toMatchObject({
        _tag: "UnexpectedStatusError",
        status: 418,
      });
    });

    it("does not invoke statusMapper for expected statuses", async () => {
      const mapper = vi.fn(() => null);
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }, 201));

      await Effect.runPromise(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "POST",
          path: "items",
          expectedStatuses: [201],
          statusMapper: mapper,
        }),
      );

      expect(mapper).not.toHaveBeenCalled();
    });
  });

  describe("redaction hook", () => {
    it("redacts bearer tokens in error bodies by default", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("Authorization: Bearer upstream-secret-token", {
          status: 401,
        }),
      );

      const error = await expectFailure(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "GET",
          path: "secure",
        }),
      );

      expect(error).toBeInstanceOf(AuthError);
      const body = (error as AuthError).body;
      expect(body).not.toContain("upstream-secret-token");
      expect(body).toContain("[REDACTED]");
    });

    it("applies ctx.redact to error bodies", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("secret-token leaked", { status: 500 }),
      );

      const error = await expectFailure(
        sendRequest(
          makeCtx({
            fetch: fetchMock,
            redact: (value) => value.replaceAll("secret-token", "[REDACTED]"),
          }),
          { method: "GET", path: "leak" },
        ),
      );

      expect(error).toBeInstanceOf(UnexpectedStatusError);
      expect((error as UnexpectedStatusError).body).toBe("[REDACTED] leaked");
      expect((error as UnexpectedStatusError).body).not.toContain(
        "secret-token",
      );
    });
  });

  describe("error path identity", () => {
    it("uses the relative request path in HTTP errors, not the full URL", async () => {
      fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));

      const error = await expectFailure(
        sendRequest(makeCtx({ fetch: fetchMock }), {
          method: "DELETE",
          path: "users/99",
        }),
      );

      expect(error).toMatchObject({
        _tag: "NotFoundError",
        path: "users/99",
      });
      expect((error as NotFoundError).path).not.toContain("api.example.com");
    });
  });
});
