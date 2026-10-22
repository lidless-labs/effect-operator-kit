import { afterEach, describe, expect, it } from "vitest";
import {
  configureResults,
  fail,
  getResultDefaults,
  ok,
  partialFailure,
  refuseUnconfirmed,
  resetResultDefaults,
  type McpTextResult,
} from "../src/result.js";

function parseText(result: McpTextResult): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe("ok", () => {
  afterEach(() => resetResultDefaults());

  it("returns compact JSON text plus structuredContent and no details", () => {
    const payload = { id: "abc", count: 2 };
    const result = ok(payload);

    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(payload) }]);
    expect(result.structuredContent).toEqual(payload);
    expect("details" in result).toBe(false);
    expect(result.isError).toBeUndefined();
  });

  it("indents the text when pretty is set", () => {
    const payload = { id: "abc" };
    expect(ok(payload, { pretty: true }).content[0]!.text).toBe(JSON.stringify(payload, null, 2));
  });

  it("emits details only when legacyDetails is on, per call or process-wide", () => {
    const payload = { id: "abc" };
    expect(ok(payload, { legacyDetails: true }).details).toEqual(payload);
    configureResults({ legacyDetails: true });
    expect(ok(payload).details).toEqual(payload);
    expect("details" in ok(payload, { legacyDetails: false })).toBe(false);
  });

  it("treats a per-call maxBytes above the process cap as the process cap", () => {
    configureResults({ maxBytes: 1500 });
    const result = ok({ rows: "r".repeat(10_000) }, { maxBytes: 5000 });
    expect(result.structuredContent).toMatchObject({ truncated: true, maxBytes: 1500 });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(1500);
  });

  it("gives non-plain objects text only, since they do not serialize to a record", () => {
    class Item {
      id = 1;
    }
    for (const value of [new Date(0), new Map(), new Item()]) {
      expect(ok(value).structuredContent).toBeUndefined();
    }
    expect(ok(Object.create(null)).structuredContent).toEqual({});
  });

  it("uses the serialized form, so a toJSON hook cannot put a non-object in structuredContent", () => {
    const toArray = { toJSON: () => [1, 2] };
    const toString = { toJSON: () => "text" };
    expect(ok(toArray).structuredContent).toBeUndefined();
    expect(ok(toString).structuredContent).toBeUndefined();
    expect(ok({ toJSON: () => ({ a: 1 }) }).structuredContent).toEqual({ a: 1 });
  });

  it("gives arrays and primitives text only, since structuredContent must be an object", () => {
    for (const value of ["hello", [1, 2], 7, null]) {
      const result = ok(value);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toEqual(value);
    }
  });

  it("emits null text for an undefined payload instead of undefined", () => {
    expect(ok(undefined).content[0]!.text).toBe("null");
  });

  it("truncates an oversize payload with a marker and a truncated flag", () => {
    const payload = { rows: "x".repeat(5000) };
    const result = ok(payload, { maxBytes: 2048, legacyDetails: true });

    const text = result.content[0]!.text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(2048);
    expect(text).toContain("[truncated: output was");
    expect(result.structuredContent).toMatchObject({ truncated: true, maxBytes: 2048 });
    expect((result.structuredContent as { originalBytes: number }).originalBytes).toBeGreaterThan(5000);
    expect(result.details).toBeUndefined();
    expect(result.isError).toBeUndefined();
  });

  it("uses the process-wide cap from configureResults", () => {
    configureResults({ maxBytes: 1500 });
    const result = ok({ rows: "y".repeat(4000) });
    expect(Buffer.byteLength(result.content[0]!.text, "utf8")).toBeLessThanOrEqual(1500);
    expect(result.structuredContent).toMatchObject({ truncated: true, maxBytes: 1500 });
  });

  it("does not flag a payload under the cap", () => {
    expect(ok({ rows: "z".repeat(100) }).structuredContent).not.toHaveProperty("truncated");
  });
});

describe("configureResults", () => {
  afterEach(() => resetResultDefaults());

  it("ships a cap below the 100,000 byte Executor limit and legacy details off", () => {
    expect(getResultDefaults()).toEqual({ maxBytes: 90_000, legacyDetails: false });
    expect(getResultDefaults().maxBytes).toBeLessThan(100_000);
  });

  it("merges partial updates and clamps an invalid cap", () => {
    configureResults({ legacyDetails: true });
    expect(configureResults({ maxBytes: -5 })).toEqual({ maxBytes: 90_000, legacyDetails: true });
    expect(configureResults({ maxBytes: 10 }).maxBytes).toBe(1024);
  });
});

describe("fail", () => {
  afterEach(() => resetResultDefaults());

  it("returns isError with { error: message } JSON text", () => {
    const result = fail("not found");

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(parseText(result)).toEqual({ error: "not found" });
    expect(result.structuredContent).toEqual({ error: "not found" });
    expect(result.details).toBeUndefined();
  });

  it("moves optional details into structuredContent without changing error text", () => {
    const details = { path: "/items/1" };
    const result = fail("missing", details);

    expect(result.isError).toBe(true);
    expect(parseText(result)).toEqual({ error: "missing" });
    expect(result.structuredContent).toEqual({ error: "missing", details });
    expect("details" in result).toBe(false);
  });

  it("keeps the legacy top-level details when asked", () => {
    const details = { path: "/items/1" };
    expect(fail("missing", details, { legacyDetails: true }).details).toEqual(details);
  });

  it("bounds an oversize error body and keeps isError", () => {
    const result = fail("boom", { dump: "q".repeat(5000) }, { maxBytes: 1024 });
    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(result.content[0]!.text, "utf8")).toBeLessThanOrEqual(1024);
    expect(result.structuredContent).toMatchObject({ truncated: true });
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
    expect(result.structuredContent).toEqual(payload);
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
    expect(result.structuredContent).toEqual(payload);
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
