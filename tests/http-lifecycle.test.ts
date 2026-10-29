import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Fiber } from "effect";
import { sendRequest, type HttpContext } from "../src/http.js";
import { exponentialRetry, withRetry } from "../src/retry.js";
import { ResponseTooLargeError } from "../src/errors.js";
import { runWithCliErrors } from "../src/adapters/cli.js";
import { runAsMcpTool } from "../src/adapters/mcp.js";

const context = (fetch: typeof globalThis.fetch, options: Partial<HttpContext> = {}): HttpContext => ({
  baseUrl: new URL("https://api.example.com/"),
  timeoutMs: 40,
  fetch,
  ...options,
});
const request = { method: "GET", path: "data", responseType: "text" } as const;

afterEach(() => vi.useRealTimers());

describe("HTTP response lifetime", () => {
  it("enforces the shipped 10 MiB cap even when response parsing is disabled", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array(10 * 1024 * 1024 + 1)));
    const result = await Effect.runPromise(Effect.either(sendRequest(context(fetch), {
      ...request, responseType: "none",
    })));
    expect(result).toMatchObject({
      _tag: "Left", left: { _tag: "ResponseTooLargeError", maxResponseBytes: 10_485_760 },
    });
  });

  it("clears the deadline after a complete response", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url, init) => {
      signal = init.signal;
      return new Response("done");
    });
    const result = await Effect.runPromise(sendRequest(context(fetch), request));
    expect(result.body).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(signal?.aborted).toBe(false);
  });

  it("uses one deadline across redirects and final body reads", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 302, headers: { location: "/end" } })
        : new Response("done");
    });
    const run = Effect.runPromise(Effect.either(sendRequest(context(fetch, { redirect: "same-origin" }), request)));
    let result: Awaited<typeof run> | undefined;
    void run.then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(50);
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "TimeoutError", timeoutMs: 40 } });
    await vi.advanceTimersByTimeAsync(20);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports byte-limit failures with request context through CLI and MCP adapters", async () => {
    const error = new ResponseTooLargeError({ method: "GET", path: "/data", maxResponseBytes: 5 });
    const lines: string[] = [];
    const result = await runWithCliErrors(Effect.fail(error), { err: (line) => lines.push(line) });
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(lines).toEqual(["ResponseTooLargeError: GET /data exceeds 5 bytes"]);
    const mcp = await runAsMcpTool(Effect.fail(error));
    expect(mcp.isError).toBe(true);
    expect(JSON.parse(mcp.content[0]!.text)).toEqual({ error: lines[0] });
  });

  it("times out a stalled body after headers and cancels the reader", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
        cancel() { cancelled = true; },
      }));
    });
    const run = Effect.runPromise(Effect.either(sendRequest(context(fetch), request)));
    let result: Awaited<typeof run> | undefined;
    void run.then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(50);
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "TimeoutError", timeoutMs: 40 } });
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a pending fetch on Effect interruption and clears its timer", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    });
    const fiber = Effect.runFork(sendRequest(context(fetch), request));
    await vi.advanceTimersByTimeAsync(0);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending body read on interruption", async () => {
    let cancelled = false;
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const fetch = vi.fn(async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({
        pull() { started(); },
        cancel() { cancelled = true; },
      }));
    });
    const fiber = Effect.runFork(sendRequest(context(fetch, { timeoutMs: 10_000 }), request));
    await ready;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it.each([200, 500])("rejects oversized chunked responses before reading the remainder (status %i)", async (status) => {
    let pulls = 0;
    let cancelled = false;
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("éé"));
        if (pulls >= 10) controller.close();
      },
      cancel() { cancelled = true; },
    }), { status }));
    const result = await Effect.runPromise(Effect.either(withRetry(
      sendRequest(context(fetch, { maxResponseBytes: 5 }), request),
      exponentialRetry({ maxAttempts: 2, initialDelayMs: 1, jitter: false }),
    )));
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ResponseTooLargeError", maxResponseBytes: 5 } });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("decodes UTF-8 split across chunks at the exact request byte limit", async () => {
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0xf0, 0x9f]));
        controller.enqueue(new Uint8Array([0x98, 0x80]));
        controller.close();
      },
    })));
    const result = await Effect.runPromise(sendRequest(
      context(fetch, { maxResponseBytes: 1 }), { ...request, maxResponseBytes: 4 },
    ));
    expect(result.bodyText).toBe("😀");
  });

  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid response byte cap %s before network I/O", async (maxResponseBytes) => {
    const fetch = vi.fn(async () => new Response("ok"));
    const result = await Effect.runPromise(Effect.either(sendRequest(context(fetch, { maxResponseBytes }), request)));
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ConfigError", key: "maxResponseBytes" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 2_147_483_648])("rejects invalid timeout %s before network I/O", async (timeoutMs) => {
    const fetch = vi.fn(async () => new Response("ok"));
    const result = await Effect.runPromise(Effect.either(sendRequest(context(fetch, { timeoutMs }), request)));
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ConfigError", key: "timeoutMs" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a body timeout only when explicitly enabled, with a fresh attempt", async () => {
    let firstSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url, init) => {
      if (!firstSignal) {
        firstSignal = init.signal;
        return new Response(new ReadableStream());
      }
      return new Response("done");
    });
    const result = await Effect.runPromise(withRetry(sendRequest(context(fetch), request), exponentialRetry({
      maxAttempts: 2, initialDelayMs: 1, jitter: false,
    })));
    expect(result.body).toBe("done");
    expect(firstSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
