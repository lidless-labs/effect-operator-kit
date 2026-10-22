import { boundResult, DEFAULT_MAX_OUTPUT_BYTES, resolveMaxOutputBytes } from "./output.js";

export interface McpTextResult<T = unknown> {
  content: Array<{ type: "text"; text: string }>;
  /** Standard MCP structured result. Present when the payload is a plain object. */
  structuredContent?: Record<string, unknown>;
  /**
   * Non-standard. Emitted only when `legacyDetails` is on. Deprecated: read
   * `structuredContent` instead.
   */
  details?: T;
  isError?: boolean;
}

export interface ResultDefaults {
  /** Cap on result bytes, UTF-8. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  maxBytes: number;
  /** Also emit the non-standard `details` field. Defaults to false. */
  legacyDetails: boolean;
}

export interface ResultOptions {
  /** Override the process-wide byte cap for this result. */
  maxBytes?: number;
  /** Override the process-wide `legacyDetails` setting for this result. */
  legacyDetails?: boolean;
  /** Indent the JSON text with two spaces instead of emitting it compact. */
  pretty?: boolean;
}

let defaults: ResultDefaults = { maxBytes: DEFAULT_MAX_OUTPUT_BYTES, legacyDetails: false };

/**
 * Set process-wide defaults for every result helper, once at server startup.
 * An app adopting the kit that still has consumers of `details` calls
 * `configureResults({ legacyDetails: true })` and removes it later.
 */
export const configureResults = (next: Partial<ResultDefaults>): ResultDefaults => {
  defaults = {
    maxBytes: resolveMaxOutputBytes(next.maxBytes ?? defaults.maxBytes),
    legacyDetails: next.legacyDetails ?? defaults.legacyDetails,
  };
  return defaults;
};

export const getResultDefaults = (): Readonly<ResultDefaults> => defaults;

/** Restore the shipped defaults. For tests. */
export const resetResultDefaults = (): void => {
  defaults = { maxBytes: DEFAULT_MAX_OUTPUT_BYTES, legacyDetails: false };
};

// A Date, Map or class instance serializes to something other than a record, so only
// object literals and null-prototype objects may become structuredContent.
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const toText = (value: unknown, pretty: boolean | undefined): string =>
  (pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)) ?? "null";

const finish = <T>(
  result: McpTextResult<T>,
  details: T | undefined,
  options: ResultOptions,
): McpTextResult<T> => {
  if (details !== undefined && (options.legacyDetails ?? defaults.legacyDetails)) {
    result.details = details;
  }
  return boundResult(result, options.maxBytes ?? defaults.maxBytes);
};

/**
 * Successful result: compact JSON text plus `structuredContent` for object
 * payloads. Arrays and primitives get text only, because MCP requires
 * structured content to be an object. Bounded by UTF-8 bytes; an oversize
 * payload is truncated with a marker and `structuredContent.truncated: true`.
 */
export const ok = <T>(details: T, options: ResultOptions = {}): McpTextResult<T> => {
  const result: McpTextResult<T> = {
    content: [{ type: "text", text: toText(details, options.pretty) }],
  };
  if (isPlainObject(details)) result.structuredContent = details;
  return finish(result, details, options);
};

export const fail = (
  message: string,
  details?: unknown,
  options: ResultOptions = {},
): McpTextResult => {
  const result: McpTextResult = {
    content: [{ type: "text", text: toText({ error: message }, options.pretty) }],
    structuredContent: details === undefined ? { error: message } : { error: message, details },
    isError: true,
  };
  return finish(result, details, options);
};

export const refuseUnconfirmed = (operation: string): McpTextResult =>
  fail(
    `Refusing to ${operation} without explicit confirmation. Re-call this tool with confirm: true to proceed.`,
  );

/**
 * Wrap a partial batch payload as a successful MCP result.
 * Caller-owned semantics: does not validate
 * `requested === succeeded + failed + skipped`, and does not set `isError`.
 * Repos decide when partial batch results are errors vs ok payloads.
 */
export const partialFailure = <T>(
  payload: {
    requested: number;
    attempted: number;
    succeeded: number;
    failed: number;
    skipped?: number;
    aborted?: boolean;
    results: T[];
  },
  options: ResultOptions = {},
): McpTextResult => ok(payload, options);
