import { Effect } from "effect";
import { ConfigError } from "./errors.js";

export interface EnvReader {
  get(key: string): string | undefined;
}

export const fromProcessEnv = (env?: NodeJS.ProcessEnv): EnvReader => ({
  get: (key) => (env ?? process.env)[key],
});

const isBlank = (raw: string | undefined): boolean =>
  raw === undefined || raw.trim() === "";

const failConfig = (partial: {
  key?: string;
  message: string;
  value?: string;
  cause?: unknown;
}): Effect.Effect<never, ConfigError> =>
  Effect.fail(new ConfigError(partial));

const readRaw = (env: EnvReader, key: string): string | undefined => env.get(key);

const TRUE_TOKENS = new Set(["true", "1", "yes", "on"]);
const FALSE_TOKENS = new Set(["false", "0", "no", "off"]);

export const requiredString = (
  env: EnvReader,
  key: string,
): Effect.Effect<string, ConfigError> => {
  const raw = readRaw(env, key);
  if (isBlank(raw)) {
    return failConfig({ key, message: `${key} is required` });
  }
  return Effect.succeed(raw!.trim());
};

export const optionalString = (
  env: EnvReader,
  key: string,
  fallback?: string,
): Effect.Effect<string | undefined, never> => {
  const raw = readRaw(env, key);
  if (isBlank(raw)) {
    return Effect.succeed(fallback);
  }
  return Effect.succeed(raw!.trim());
};

export const parseBooleanEnv = (
  env: EnvReader,
  key: string,
  fallback: boolean,
): Effect.Effect<boolean, ConfigError> => {
  const raw = readRaw(env, key);
  if (isBlank(raw)) {
    return Effect.succeed(fallback);
  }
  const token = raw!.trim().toLowerCase();
  if (TRUE_TOKENS.has(token)) {
    return Effect.succeed(true);
  }
  if (FALSE_TOKENS.has(token)) {
    return Effect.succeed(false);
  }
  return failConfig({
    key,
    value: raw,
    message: `${key} must be a boolean (true/false, 1/0, yes/no, on/off)`,
  });
};

const parseFiniteNumber = (
  env: EnvReader,
  key: string,
  opts: { fallback?: number; min?: number; max?: number },
  invalidMessage: string,
): Effect.Effect<number, ConfigError> => {
  const raw = readRaw(env, key);
  if (isBlank(raw)) {
    if (opts.fallback !== undefined) {
      return Effect.succeed(opts.fallback);
    }
    return failConfig({ key, message: `${key} is required` });
  }

  const parsed = Number(raw!.trim());
  if (!Number.isFinite(parsed)) {
    return failConfig({
      key,
      value: raw,
      message: invalidMessage,
    });
  }

  if (opts.min !== undefined && parsed < opts.min) {
    return failConfig({
      key,
      value: raw,
      message: `${key} must be at least ${opts.min}`,
    });
  }

  if (opts.max !== undefined && parsed > opts.max) {
    return failConfig({
      key,
      value: raw,
      message: `${key} must be at most ${opts.max}`,
    });
  }

  return Effect.succeed(parsed);
};

export const parseNumberEnv = (
  env: EnvReader,
  key: string,
  opts: { fallback?: number; min?: number; max?: number },
): Effect.Effect<number, ConfigError> =>
  parseFiniteNumber(env, key, opts, `${key} must be a finite number`);

export const parsePositiveIntEnv = (
  env: EnvReader,
  key: string,
  opts?: { fallback?: number; min?: number; max?: number },
): Effect.Effect<number, ConfigError> =>
  Effect.gen(function* () {
    const value = yield* parseFiniteNumber(
      env,
      key,
      opts ?? {},
      `${key} must be a positive integer`,
    );
    if (!Number.isInteger(value) || value <= 0) {
      const raw = readRaw(env, key);
      return yield* failConfig({
        key,
        value: raw,
        message: `${key} must be a positive integer`,
      });
    }
    return value;
  });

export const parseTimeoutEnv = (
  env: EnvReader,
  key: string,
  opts: {
    fallbackMs: number;
    minMs?: number;
    maxMs?: number;
    unit?: "ms" | "s";
  },
): Effect.Effect<number, ConfigError> => {
  const raw = readRaw(env, key);
  if (isBlank(raw)) {
    return Effect.succeed(opts.fallbackMs);
  }

  const parsed = Number(raw!.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return failConfig({
      key,
      value: raw,
      message: `${key} must be a positive timeout`,
    });
  }

  const unit = opts.unit ?? "s";
  const ms = unit === "ms" ? parsed : parsed * 1000;

  if (opts.minMs !== undefined && ms < opts.minMs) {
    return failConfig({
      key,
      value: raw,
      message: `${key} must be at least ${opts.minMs}ms`,
    });
  }

  if (opts.maxMs !== undefined && ms > opts.maxMs) {
    return failConfig({
      key,
      value: raw,
      message: `${key} must be at most ${opts.maxMs}ms`,
    });
  }

  return Effect.succeed(ms);
};

export const normalizeBaseUrl = (
  value: string,
  opts?: { stripTrailingSlash?: boolean; ensurePath?: string },
): URL => {
  const url = new URL(value);

  let pathname = url.pathname;
  if (opts?.stripTrailingSlash !== false) {
    pathname = pathname.replace(/\/+$/, "");
    if (pathname === "") {
      pathname = "/";
    }
  }

  if (opts?.ensurePath) {
    const segment = opts.ensurePath.startsWith("/")
      ? opts.ensurePath
      : `/${opts.ensurePath}`;
    const segmentNorm = segment.replace(/\/+$/, "");

    if (pathname === "/" || pathname === "") {
      pathname = segmentNorm;
    } else if (pathname === segmentNorm || pathname.endsWith(segmentNorm)) {
      pathname = pathname.replace(/\/+$/, "") || segmentNorm;
      if (!pathname.endsWith(segmentNorm)) {
        pathname = segmentNorm;
      }
    } else {
      pathname = `${pathname.replace(/\/+$/, "")}${segmentNorm}`;
    }
  }

  url.pathname = pathname;
  return url;
};
