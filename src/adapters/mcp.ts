import { Cause, Effect } from "effect";
import type { OperatorError } from "../errors.js";
import { fail, type McpTextResult } from "../result.js";

type TaggedShape = {
  _tag: string;
  message?: string;
  method?: string;
  path?: string;
  status?: number;
  timeoutMs?: number;
  key?: string;
};

/**
 * Thin message extraction for MCP fail() text. Prefers Error.message /
 * tagged message fields; never serializes body/cause (secret-prone).
 */
export const operatorErrorMessage = (error: unknown): string => {
  if (isTaggedShape(error)) {
    // Prefer explicit tagged `message` (ConfigError / ParseError) when it is
    // more than the bare tag name (TaggedError may default message to _tag).
    if (
      typeof error.message === "string" &&
      error.message.length > 0 &&
      error.message !== error._tag
    ) {
      return error.message;
    }
    return formatTaggedThin(error);
  }

  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
};

function isTaggedShape(error: unknown): error is TaggedShape {
  return (
    error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    typeof (error as { _tag: unknown })._tag === "string"
  );
}

function formatTaggedThin(error: {
  _tag: string;
  message?: string;
  method?: string;
  path?: string;
  status?: number;
  timeoutMs?: number;
  key?: string;
}): string {
  switch (error._tag) {
    case "ConfigError":
      return error.key
        ? `ConfigError: ${error.key}${error.message ? `: ${error.message}` : ""}`
        : error.message || "ConfigError";
    case "TimeoutError":
      return `TimeoutError: ${error.method ?? "?"} ${error.path ?? "?"} after ${error.timeoutMs ?? "?"}ms`;
    case "AuthError":
    case "ForbiddenError":
    case "NotFoundError":
    case "UnexpectedStatusError":
      return `${error._tag}: ${error.method ?? "?"} ${error.path ?? "?"}${
        error.status !== undefined ? ` (${error.status})` : ""
      }`;
    case "TransportError":
      return `TransportError: ${error.method ?? "?"} ${error.path ?? "?"}`;
    case "ParseError":
      return error.message || `ParseError${error.path ? `: ${error.path}` : ""}`;
    default:
      return error.message || error._tag;
  }
}

/** Convert an Effect with OperatorError (or defects) into always-succeeding McpTextResult. */
export const toMcpResult = (
  effect: Effect.Effect<McpTextResult, OperatorError>,
): Effect.Effect<McpTextResult, never> =>
  Effect.either(Effect.sandbox(effect)).pipe(
    Effect.map((result) =>
      result._tag === "Left"
        ? fail(operatorErrorMessage(Cause.squash(result.left)))
        : result.right,
    ),
  );

export const runAsMcpTool = (
  effect: Effect.Effect<McpTextResult, OperatorError>,
): Promise<McpTextResult> => Effect.runPromise(toMcpResult(effect));

export const toToolHandler =
  <Args>(
    handler: (args: Args) => Effect.Effect<McpTextResult, OperatorError>,
  ): ((args: Args) => Promise<McpTextResult>) =>
  (args) => {
    try {
      return runAsMcpTool(handler(args));
    } catch (error) {
      return Promise.resolve(fail(operatorErrorMessage(error)));
    }
  };

