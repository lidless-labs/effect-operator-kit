import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { sendRequest } from "../src/http.js";
import { exponentialRetry, withRetry } from "../src/retry.js";

const policy = exponentialRetry({ maxAttempts: 2, initialDelayMs: 1, jitter: false });
const baseUrl = new URL("https://api.example.com/");

describe("retry safety after dispatch", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    it.each(["body-timeout", "body-error", "server-error"] as const)(`${method} does not replay after %s`, async (failure) => {
      const fetch = vi.fn(async () => {
        if (failure === "server-error") return new Response("failed", { status: 503 });
        if (fetch.mock.calls.length > 1) return new Response("duplicate mutation");
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { if (failure === "body-error") controller.error(new Error("fixture disconnect")); },
        }));
      });
      const result = await Effect.runPromise(Effect.either(withRetry(sendRequest({
        baseUrl, timeoutMs: 30, fetch,
      }, { method, path: "mutate", responseType: "text" }), policy)));
      expect(result._tag).toBe("Left");
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }

  for (const method of ["GET", "POST"] as const) {
    it.each(["disabled", "cross-origin", "userinfo", "malformed", "loop"] as const)(`${method} redirect %s does not restart the original request`, async (kind) => {
      const location = {
        disabled: "/elsewhere", "cross-origin": "https://other.example.com/",
        userinfo: "https://fixture@api.example.com/", malformed: "http://[invalid", loop: "/start",
      }[kind];
      const fetch = vi.fn(async () => new Response(null, { status: 307, headers: { location } }));
      const result = await Effect.runPromise(Effect.either(withRetry(sendRequest({
        baseUrl, timeoutMs: 1000, fetch, redirect: kind === "disabled" ? "error" : "same-origin",
      }, { method, path: "start", responseType: "text" }), policy)));
      expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ConfigError", key: "redirect" } });
      expect(fetch).toHaveBeenCalledTimes(kind === "loop" ? 11 : 1);
    });
  }
});
