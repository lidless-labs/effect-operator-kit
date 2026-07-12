import { describe, expect, it } from "vitest";
import {
  fail,
  ok,
  partialFailure,
  refuseUnconfirmed,
  type McpTextResult,
} from "../src/result.js";

function parseText(result: McpTextResult): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe("ok", () => {
  it("returns text content with pretty-printed JSON and details", () => {
    const details = { id: "abc", count: 2 };
    const result = ok(details);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(details, null, 2),
    });
    expect(result.details).toEqual(details);
    expect(result.isError).toBeUndefined();
  });

  it("accepts primitive and array payloads", () => {
    expect(ok("hello").details).toBe("hello");
    expect(ok([1, 2]).details).toEqual([1, 2]);
  });
});

describe("fail", () => {
  it("returns isError with { error: message } JSON text", () => {
    const result = fail("not found");

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(parseText(result)).toEqual({ error: "not found" });
    expect(result.details).toBeUndefined();
  });

  it("attaches optional details without changing error text shape", () => {
    const details = { path: "/items/1" };
    const result = fail("missing", details);

    expect(result.isError).toBe(true);
    expect(parseText(result)).toEqual({ error: "missing" });
    expect(result.details).toEqual(details);
  });
});

describe("refuseUnconfirmed", () => {
  it("returns isError refusal embedding the operation", () => {
    const result = refuseUnconfirmed("delete user u1");

    expect(result.isError).toBe(true);
    const body = parseText(result) as { error: string };
    expect(body.error).toContain("delete user u1");
    expect(body.error.toLowerCase()).toMatch(/confirm/);
    expect(body.error.toLowerCase()).toMatch(/refus/);
  });
});

describe("partialFailure", () => {
  it("encodes counters and results like ok (no forced isError)", () => {
    const payload = {
      requested: 3,
      attempted: 3,
      succeeded: 2,
      failed: 1,
      results: [{ ok: true }, { ok: false, error: "boom" }],
    };
    const result = partialFailure(payload);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.type).toBe("text");
    expect(parseText(result)).toEqual(payload);
    expect(result.details).toEqual(payload);
  });

  it("includes optional skipped and aborted when provided", () => {
    const payload = {
      requested: 5,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      skipped: 3,
      aborted: true,
      results: ["a", "b"],
    };
    const result = partialFailure(payload);

    expect(parseText(result)).toEqual(payload);
    expect(result.details).toEqual(payload);
  });
});

describe("McpTextResult shape invariants", () => {
  it("always uses a single text content block", () => {
    for (const result of [
      ok({ x: 1 }),
      fail("e"),
      refuseUnconfirmed("op"),
      partialFailure({
        requested: 1,
        attempted: 1,
        succeeded: 0,
        failed: 1,
        results: [],
      }),
    ]) {
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      expect(typeof result.content[0]!.text).toBe("string");
    }
  });
});
