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

const structuredBytes = (value: Record<string, unknown> | undefined): number =>
  value === undefined ? 0 : utf8ByteLength(JSON.stringify(value));

/**
 * Bound a result by UTF-8 bytes: the text blocks together, and the serialized
 * `structuredContent`. A result within the cap is returned as is. Over the
 * cap, the text is cut with a marker, `structuredContent` becomes
 * `{ truncated: true, originalBytes, returnedBytes, maxBytes }`, and the legacy
 * `details` field is dropped, since either would otherwise repeat the full
 * payload on the wire.
 */
export const boundResult = <R extends BoundableResult>(
  result: R,
  maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
): R => {
  const cap = resolveMaxOutputBytes(maxBytes);
  const joined = result.content.map((block) => block.text).join("\n");
  const originalBytes = Math.max(utf8ByteLength(joined), structuredBytes(result.structuredContent));
  if (originalBytes <= cap) return result;

  const text = cutWithMarker(joined, originalBytes, cap);
  const { details: _details, ...rest } = result;
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
