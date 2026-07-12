import { Cause, Effect, Exit } from "effect";
import type { OperatorError } from "../errors.js";

export type StderrWriter = (line: string) => void;

/**
 * Thin one-line format for OperatorError. Prefers `message` / `_tag` and
 * identifying fields; never includes body or cause (secret-prone).
 */
export const formatOperatorError = (error: OperatorError): string => {
  switch (error._tag) {
    case "ConfigError": {
      if (error.message) return error.message;
      return error.key ? `ConfigError: ${error.key}` : "ConfigError";
    }
    case "ParseError":
      return error.message || `ParseError${error.path ? `: ${error.path}` : ""}`;
    case "TimeoutError":
      return `TimeoutError: ${error.method} ${error.path} after ${error.timeoutMs}ms`;
    case "AuthError":
    case "ForbiddenError":
    case "NotFoundError":
      return `${error._tag}: ${error.method} ${error.path} (${error.status})`;
    case "UnexpectedStatusError":
      return `UnexpectedStatusError: ${error.method} ${error.path} (${error.status})`;
    case "TransportError":
      return `TransportError: ${error.method} ${error.path}`;
    default: {
      const _exhaustive: never = error;
      return String(_exhaustive);
    }
  }
};

/** Default exit code for any OperatorError. Usage/argv exit 2 stays repo-owned. */
export const exitCodeForOperatorError = (_error: OperatorError): number => 1;

export const writeOperatorError = (
  error: OperatorError,
  err: StderrWriter,
): void => {
  err(formatOperatorError(error));
};

export const runWithCliErrors = async <A>(
  effect: Effect.Effect<A, OperatorError>,
  deps: {
    err: StderrWriter;
    formatError?: (e: OperatorError) => string;
    exitCodeFor?: (e: OperatorError) => number;
  },
): Promise<{ ok: true; value: A } | { ok: false; exitCode: number }> => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.match(exit, {
    onSuccess: (value) => ({ ok: true as const, value }),
    onFailure: (cause) => {
      const squashed = Cause.squash(cause);
      const format = deps.formatError ?? formatOperatorError;
      const codeFor = deps.exitCodeFor ?? exitCodeForOperatorError;

      if (isOperatorError(squashed)) {
        deps.err(format(squashed));
        return { ok: false as const, exitCode: codeFor(squashed) };
      }

      const message =
        squashed instanceof Error
          ? squashed.message
          : String(squashed ?? "Unknown error");
      deps.err(message);
      return { ok: false as const, exitCode: 1 };
    },
  });
};

function isOperatorError(value: unknown): value is OperatorError {
  return (
    value !== null &&
    typeof value === "object" &&
    "_tag" in value &&
    typeof (value as { _tag: unknown })._tag === "string" &&
    [
      "ConfigError",
      "AuthError",
      "ForbiddenError",
      "NotFoundError",
      "TimeoutError",
      "TransportError",
      "ParseError",
      "UnexpectedStatusError",
    ].includes((value as { _tag: string })._tag)
  );
}
