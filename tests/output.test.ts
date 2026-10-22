import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  MIN_MAX_OUTPUT_BYTES,
  boundResult,
  boundText,
  resolveMaxOutputBytes,
  truncateUtf8,
  utf8ByteLength,
  type BoundableResult,
} from "../src/output.js";

describe("resolveMaxOutputBytes", () => {
  it("defaults below the Executor 100,000 byte limit", () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeLessThan(100_000);
    expect(resolveMaxOutputBytes(undefined)).toBe(DEFAULT_MAX_OUTPUT_BYTES);
  });

  it("falls back on non-positive and non-integer values and clamps small ones", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(resolveMaxOutputBytes(bad)).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    }
    expect(resolveMaxOutputBytes(10)).toBe(MIN_MAX_OUTPUT_BYTES);
    expect(resolveMaxOutputBytes(5000)).toBe(5000);
  });
});

describe("truncateUtf8", () => {
  it("returns short text unchanged", () => {
    expect(truncateUtf8("hello", 10)).toBe("hello");
  });

  it("never splits a multi-byte character", () => {
    // Each of these is 3 bytes in UTF-8.
    const text = "€".repeat(10);
    for (let max = 0; max <= 30; max += 1) {
      const cut = truncateUtf8(text, max);
      expect(utf8ByteLength(cut)).toBeLessThanOrEqual(max);
      expect(cut).not.toContain("�");
      expect(cut).toBe("€".repeat(Math.floor(max / 3)));
    }
  });

  it("handles 4-byte characters", () => {
    const text = "\u{1f600}".repeat(5);
    expect(truncateUtf8(text, 9)).toBe("\u{1f600}".repeat(2));
  });
});

describe("boundText", () => {
  it("measures bytes, not characters", () => {
    const text = "€".repeat(1000); // 1000 chars, 3000 bytes
    const bounded = boundText(text, 2048);
    expect(bounded.originalBytes).toBe(3000);
    expect(bounded.truncated).toBe(true);
    expect(bounded.returnedBytes).toBeLessThanOrEqual(2048);
    expect(utf8ByteLength(bounded.text)).toBe(bounded.returnedBytes);
  });

  it("leaves text at exactly the cap alone", () => {
    const text = "a".repeat(2048);
    const bounded = boundText(text, 2048);
    expect(bounded.truncated).toBe(false);
    expect(bounded.text).toBe(text);
  });

  it("appends a marker that states the original size and the limit", () => {
    const bounded = boundText("b".repeat(4000), 2048);
    expect(bounded.text).toMatch(/\[truncated: output was 4000 bytes, limit is 2048 bytes\./);
    expect(bounded.text.startsWith("bbbb")).toBe(true);
  });

  it("uses the default cap", () => {
    const bounded = boundText("c".repeat(DEFAULT_MAX_OUTPUT_BYTES + 1));
    expect(bounded.truncated).toBe(true);
    expect(bounded.returnedBytes).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_BYTES);
  });

  it("fits a marker even at the smallest honored cap", () => {
    const bounded = boundText("d".repeat(10_000), 1);
    expect(bounded.maxBytes).toBe(MIN_MAX_OUTPUT_BYTES);
    expect(bounded.returnedBytes).toBeLessThanOrEqual(MIN_MAX_OUTPUT_BYTES);
    expect(bounded.text).toContain("[truncated:");
  });
});

describe("boundResult", () => {
  const make = (text: string, extra: Partial<BoundableResult> = {}): BoundableResult => ({
    content: [{ type: "text", text }],
    ...extra,
  });

  it("returns the same object when within the cap", () => {
    const result = make("small", { structuredContent: { a: 1 } });
    expect(boundResult(result, 2048)).toBe(result);
  });

  it("truncates text, replaces structuredContent, drops details and keeps isError", () => {
    const result = make("e".repeat(5000), {
      structuredContent: { big: "e".repeat(4900) },
      details: { big: "e".repeat(4900) },
      isError: true,
    });
    const bounded = boundResult(result, 2048);

    expect(bounded.isError).toBe(true);
    expect("details" in bounded).toBe(false);
    expect(bounded.content).toHaveLength(1);
    expect(utf8ByteLength(bounded.content[0]!.text)).toBeLessThanOrEqual(2048);
    expect(bounded.structuredContent).toEqual({
      truncated: true,
      originalBytes: expect.any(Number),
      returnedBytes: utf8ByteLength(bounded.content[0]!.text),
      maxBytes: 2048,
    });
  });

  it("joins several text blocks and bounds them together", () => {
    const result: BoundableResult = {
      content: [
        { type: "text", text: "f".repeat(1500) },
        { type: "text", text: "g".repeat(1500) },
      ],
    };
    const bounded = boundResult(result, 2048);
    expect(bounded.content).toHaveLength(1);
    expect(utf8ByteLength(bounded.content[0]!.text)).toBeLessThanOrEqual(2048);
    expect(bounded.structuredContent).toMatchObject({ truncated: true });
  });

  it("flags an oversize structuredContent even when the text fits", () => {
    const result = make("short", { structuredContent: { big: "h".repeat(5000) } });
    const bounded = boundResult(result, 2048);
    expect(bounded.structuredContent).toMatchObject({ truncated: true });
    expect(bounded.content[0]!.text).toContain("[truncated:");
    expect(utf8ByteLength(bounded.content[0]!.text)).toBeLessThanOrEqual(2048);
  });

  it("counts text, structuredContent and details together", () => {
    // Each copy is under the cap on its own; together they are about 3x.
    const payload = { big: "j".repeat(900) };
    const result = make(JSON.stringify(payload), { structuredContent: payload, details: payload });
    const bounded = boundResult(result, 2048);
    expect(bounded.structuredContent).toMatchObject({ truncated: true });
    expect("details" in bounded).toBe(false);
  });

  it("keeps the whole serialized result, metadata included, within the cap", () => {
    const payload = { big: "k".repeat(30_000) };
    const result = make(JSON.stringify(payload), { structuredContent: payload });
    for (const cap of [1024, 2048, 90_000]) {
      const bounded = boundResult(result, cap);
      const total =
        utf8ByteLength(bounded.content[0]!.text) +
        utf8ByteLength(JSON.stringify(bounded.structuredContent));
      expect(total, `cap ${cap}`).toBeLessThanOrEqual(cap);
    }
  });

  it("leaves a plain-object payload alone when the duplicated copies still fit", () => {
    const payload = { big: "m".repeat(400) };
    const result = make(JSON.stringify(payload), { structuredContent: payload });
    expect(boundResult(result, 2048)).toBe(result);
  });

  it("does not mutate its input", () => {
    const result = make("i".repeat(5000), { details: { x: 1 } });
    boundResult(result, 2048);
    expect(result.details).toEqual({ x: 1 });
    expect(result.content[0]!.text).toHaveLength(5000);
  });
});
