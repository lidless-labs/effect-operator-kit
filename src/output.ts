/**
 * Byte-based output bounding for MCP tool results.
 *
 * Executor v2 refuses a result over 100,000 bytes instead of cutting it, so
 * a server must bound its own output. The cap is measured in UTF-8 bytes, not
 * characters, and an oversize result is truncated with an explicit marker and
 * a `truncated: true` structured flag instead of failing the call.
 */

/** Default cap, below Executor v2's 100,000 byte output limit. */
export const DEFAULT_MAX_OUTPUT_BYTES = 90_000;

/** Smallest cap honored, so the truncation marker always fits. */
export const MIN_MAX_OUTPUT_BYTES = 1024;

/** Structural slice of an MCP tool result that {@link boundResult} reads and writes. */
export interface BoundableResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  details?: unknown;
  isError?: boolean;
}

const encoder = new TextEncoder();

export const utf8ByteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** Valid cap for a caller-supplied value: non-integers fall back, small values clamp up. */
export const resolveMaxOutputBytes = (value: number | undefined): number => {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_MAX_OUTPUT_BYTES;
  }
  return Math.max(value, MIN_MAX_OUTPUT_BYTES);
};

/** Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export const truncateUtf8 = (text: string, maxBytes: number): string => {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const bytes = encoder.encode(text);
  let end = Math.max(0, Math.min(maxBytes, bytes.length));
  // Back up over continuation bytes (10xxxxxx) so the cut lands on a boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return Buffer.from(bytes.subarray(0, end)).toString("utf8");
};

export interface BoundedText {
  text: string;
  truncated: boolean;
  originalBytes: number;
  /** Byte length of `text`, marker included. Never above `maxBytes`. */
  returnedBytes: number;
  maxBytes: number;
}

export const truncationMarker = (originalBytes: number, maxBytes: number): string =>
  `\n[truncated: output was ${originalBytes} bytes, limit is ${maxBytes} bytes. Narrow the request with filters, a smaller limit or an offset to see the rest.]`;

const cutWithMarker = (text: string, originalBytes: number, cap: number): string => {
  const marker = truncationMarker(originalBytes, cap);
  return truncateUtf8(text, cap - utf8ByteLength(marker)) + marker;
};

/**
 * Bound `text` by UTF-8 bytes. Over the cap, keeps a prefix and appends a
 * marker; the whole returned text, marker included, fits in `maxBytes`.
 */
export const boundText = (
  text: string,
  maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
): BoundedText => {
  const cap = resolveMaxOutputBytes(maxBytes);
  const originalBytes = utf8ByteLength(text);
  if (originalBytes <= cap) {
    return { text, truncated: false, originalBytes, returnedBytes: originalBytes, maxBytes: cap };
  }
  const bounded = cutWithMarker(text, originalBytes, cap);
  return {
    text: bounded,
    truncated: true,
    originalBytes,
    returnedBytes: utf8ByteLength(bounded),
    maxBytes: cap,
  };
};

const serializedBytes = (value: unknown): number =>
  value === undefined ? 0 : utf8ByteLength(JSON.stringify(value) ?? "");

/** UTF-8 bytes `character` takes inside a JSON string literal, escapes included. */
const encodedBytes = (character: string): number => {
  const code = character.codePointAt(0)!;
  if (code === 0x22 || code === 0x5c) return 2;
  if (code < 0x20) return code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
  // A lone surrogate is written as a \uXXXX escape by JSON.stringify.
  if (code >= 0xd800 && code <= 0xdfff) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return code < 0x10000 ? 3 : 4;
};

const encodedTextBytes = (text: string): number => {
  let total = 0;
  for (const character of text) total += encodedBytes(character);
  return total;
};

/**
 * Longest prefix of `text` whose JSON string encoding fits `budget` bytes. A
 * block's text is escaped again when the result is serialized, so the decoded
 * length undercounts quote, backslash and control heavy output.
 */
const truncateEncoded = (text: string, budget: number): string => {
  let used = 0;
  let end = 0;
  for (const character of text) {
    used += encodedBytes(character);
    if (used > budget) break;
    end += character.length;
  }
  return text.slice(0, end);
};

/**
 * Bound a result by UTF-8 bytes of its serialized form. The size is what goes on
 * the wire: the whole result as JSON, so a plain-object payload counts once in the
 * text block (escaped again) and once in `structuredContent`, and `details` counts
 * when present. A result within the cap is returned as is. Over the cap, the text
 * is cut with a marker, `structuredContent` becomes
 * `{ truncated: true, originalBytes, returnedBytes, maxBytes }`, and the legacy
 * `details` field and any other fields are dropped, since they would otherwise repeat
 * or add to the payload; only `isError` is kept. The serialized replacement fits in
 * the cap.
 */
export const boundResult = <R extends BoundableResult>(
  result: R,
  maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
): R => {
  const cap = resolveMaxOutputBytes(maxBytes);
  const originalBytes = serializedBytes(result);
  if (originalBytes <= cap) return result;

  const joined = result.content.map((block) => block.text).join("\n");
  // The replacement keeps only the fields the cap is about. Other fields (the standard
  // `_meta`, `details`, anything an app added) can be arbitrarily large, so they are dropped.
  const rest = result.isError === undefined ? {} : { isError: result.isError };
  const widest = { truncated: true, originalBytes, returnedBytes: cap, maxBytes: cap };
  // Everything in the replacement except the text itself, with the widest counts.
  const fixed = serializedBytes({
    ...rest,
    content: [{ type: "text", text: "" }],
    structuredContent: widest,
  });
  const marker = truncationMarker(originalBytes, cap);
  const budget = cap - fixed - encodedTextBytes(marker);
  const text = truncateEncoded(joined, Math.max(0, budget)) + marker;
  return {
    ...rest,
    content: [{ type: "text", text }],
    structuredContent: {
      truncated: true,
      originalBytes,
      returnedBytes: utf8ByteLength(text),
      maxBytes: cap,
    },
  } as unknown as R;
};
