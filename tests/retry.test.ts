import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  AuthError,
  ConfigError,
  ForbiddenError,
  NotFoundError,
  ParseError,
  TimeoutError,
  TransportError,
  UnexpectedStatusError,
  type OperatorError,
} from "../src/errors.js";
import {
  exponentialRetry,
  noRetry,
  withRetry,
  type RetryPolicy,
} from "../src/retry.js";

const transportErr = () =>
  new TransportError({
    method: "GET",
    path: "/x",
    cause: new Error("ECONNRESET"),
  });

const authErr = () =>
  new AuthError({ method: "GET", path: "/x", status: 401, body: "nope" });

const notFoundErr = () =>
  new NotFoundError({ method: "GET", path: "/x", status: 404 });

const timeoutErr = () =>
  new TimeoutError({ method: "GET", path: "/x", timeoutMs: 1000 });

const statusErr = (status: number) =>
  new UnexpectedStatusError({
    method: "GET",
    path: "/x",
    status,
    body: "err",
    expected: [200],
  });

const parseErr = () =>
  new ParseError({ path: "/x", message: "bad json", body: "{" });

const configErr = () =>
  new ConfigError({ key: "FOO", message: "FOO is required" });

const forbiddenErr = () =>
  new ForbiddenError({ method: "GET", path: "/x", status: 403 });

async function runEither<A>(
  effect: Effect.Effect<A, OperatorError>,
): Promise<{ _tag: "Right"; right: A } | { _tag: "Left"; left: OperatorError }> {
  return Effect.runPromise(Effect.either(effect));
}

function failingEffect(attempts: { count: number }, error: () => OperatorError) {
  return Effect.gen(function* () {
    attempts.count += 1;
    return yield* Effect.fail(error());
  });
}

function eventuallySucceeds(
  attempts: { count: number },
  failTimes: number,
  error: () => OperatorError,
  value = "ok",
) {
  return Effect.gen(function* () {
    attempts.count += 1;
    if (attempts.count <= failTimes) {
      return yield* Effect.fail(error());
    }
    return value;
  });
}

describe("noRetry", () => {
  it("is disabled by default", () => {
    expect(noRetry.enabled).toBe(false);
  });

  it("exposes a full RetryPolicy shape", () => {
    const policy: RetryPolicy = noRetry;
    expect(typeof policy.maxAttempts).toBe("number");
    expect(typeof policy.initialDelayMs).toBe("number");
    expect(typeof policy.maxDelayMs).toBe("number");
    expect(typeof policy.factor).toBe("number");
    expect(typeof policy.jitter).toBe("boolean");
    expect(typeof policy.shouldRetry).toBe("function");
    expect(policy.shouldRetry(transportErr())).toBe(false);
  });

  it("withRetry(effect, noRetry) runs the effect once", async () => {
    const attempts = { count: 0 };
    const result = await runEither(
      withRetry(failingEffect(attempts, transportErr), noRetry),
    );
    expect(attempts.count).toBe(1);
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("TransportError");
    }
  });
});

describe("withRetry disabled-by-default", () => {
  it("withRetry(effect) with no policy runs once (disabled default)", async () => {
    const attempts = { count: 0 };
    const result = await runEither(withRetry(failingEffect(attempts, transportErr)));
    expect(attempts.count).toBe(1);
    expect(result._tag).toBe("Left");
  });

  it("policy.enabled === false skips retry even with high maxAttempts", async () => {
    const attempts = { count: 0 };
    const policy = exponentialRetry({
      enabled: false,
      maxAttempts: 5,
      initialDelayMs: 1,
      jitter: false,
    });
    const result = await runEither(
      withRetry(failingEffect(attempts, transportErr), policy),
    );
    expect(attempts.count).toBe(1);
    expect(result._tag).toBe("Left");
  });
});

describe("exponentialRetry policy", () => {
  it("defaults to enabled with positive backoff fields", () => {
    const policy = exponentialRetry({});
    expect(policy.enabled).toBe(true);
    expect(policy.maxAttempts).toBeGreaterThanOrEqual(2);
    expect(policy.initialDelayMs).toBeGreaterThan(0);
    expect(policy.maxDelayMs).toBeGreaterThanOrEqual(policy.initialDelayMs);
    expect(policy.factor).toBeGreaterThan(1);
    expect(typeof policy.jitter).toBe("boolean");
    expect(typeof policy.shouldRetry).toBe("function");
  });

  it("merges Partial overrides", () => {
    const policy = exponentialRetry({
      maxAttempts: 2,
      initialDelayMs: 1,
      maxDelayMs: 10,
      factor: 3,
      jitter: false,
    });
    expect(policy.enabled).toBe(true);
    expect(policy.maxAttempts).toBe(2);
    expect(policy.initialDelayMs).toBe(1);
    expect(policy.maxDelayMs).toBe(10);
    expect(policy.factor).toBe(3);
    expect(policy.jitter).toBe(false);
  });

  it("allows replacing shouldRetry entirely", () => {
    const policy = exponentialRetry({
      shouldRetry: (e) => e._tag === "AuthError",
    });
    expect(policy.shouldRetry(authErr())).toBe(true);
    expect(policy.shouldRetry(transportErr())).toBe(false);
  });
});

describe("default shouldRetry matrix (transport / 5xx only)", () => {
  const policy = () => exponentialRetry({});

  it("retries TransportError", () => {
    expect(policy().shouldRetry(transportErr())).toBe(true);
  });

  it("retries TimeoutError", () => {
    expect(policy().shouldRetry(timeoutErr())).toBe(true);
  });

  it("retries UnexpectedStatusError with status >= 500", () => {
    expect(policy().shouldRetry(statusErr(500))).toBe(true);
    expect(policy().shouldRetry(statusErr(503))).toBe(true);
  });

  it("does not retry 4xx UnexpectedStatusError", () => {
    expect(policy().shouldRetry(statusErr(429))).toBe(false);
    expect(policy().shouldRetry(statusErr(400))).toBe(false);
  });

  it("does not retry Auth / Forbidden / NotFound", () => {
    expect(policy().shouldRetry(authErr())).toBe(false);
    expect(policy().shouldRetry(forbiddenErr())).toBe(false);
    expect(policy().shouldRetry(notFoundErr())).toBe(false);
  });

  it("does not retry ConfigError or ParseError", () => {
    expect(policy().shouldRetry(configErr())).toBe(false);
    expect(policy().shouldRetry(parseErr())).toBe(false);
  });
});

describe("withRetry Effect Schedule behavior", () => {
  it("retries until success within maxAttempts (total tries)", async () => {
    const attempts = { count: 0 };
    const policy = exponentialRetry({
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 5,
      jitter: false,
    });
    const result = await runEither(
      withRetry(eventuallySucceeds(attempts, 2, transportErr, "done"), policy),
    );
    expect(attempts.count).toBe(3);
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).toBe("done");
    }
  });

  it("exhausts retries and surfaces the last OperatorError", async () => {
    const attempts = { count: 0 };
    const policy = exponentialRetry({
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 5,
      jitter: false,
    });
    const result = await runEither(
      withRetry(failingEffect(attempts, transportErr), policy),
    );
    expect(attempts.count).toBe(3);
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("TransportError");
    }
  });

  it("stops immediately when shouldRetry returns false", async () => {
    const attempts = { count: 0 };
    const policy = exponentialRetry({
      maxAttempts: 5,
      initialDelayMs: 1,
      jitter: false,
    });
    const result = await runEither(
      withRetry(failingEffect(attempts, authErr), policy),
    );
    expect(attempts.count).toBe(1);
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("AuthError");
    }
  });

  it("stops when a later failure is non-retryable", async () => {
    const attempts = { count: 0 };
    const policy = exponentialRetry({
      maxAttempts: 5,
      initialDelayMs: 1,
      jitter: false,
    });
    const effect = Effect.gen(function* () {
      attempts.count += 1;
      if (attempts.count === 1) {
        return yield* Effect.fail(transportErr());
      }
      return yield* Effect.fail(notFoundErr());
    });
    const result = await runEither(withRetry(effect, policy));
    expect(attempts.count).toBe(2);
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("NotFoundError");
    }
  });

  it("honors custom shouldRetry stop conditions", async () => {
    const attempts = { count: 0 };
    const policy = exponentialRetry({
      maxAttempts: 4,
      initialDelayMs: 1,
      jitter: false,
      shouldRetry: (e) => e._tag === "ParseError",
    });
    // Transport is not retryable under this policy
    await runEither(withRetry(failingEffect(attempts, transportErr), policy));
    expect(attempts.count).toBe(1);

    attempts.count = 0;
    const parseAttempts = { count: 0 };
    await runEither(
      withRetry(failingEffect(parseAttempts, parseErr), policy),
    );
    expect(parseAttempts.count).toBe(4);
  });

  it("maxAttempts of 1 means a single try even when enabled", async () => {
    const attempts = { count: 0 };
    const policy = exponentialRetry({
      maxAttempts: 1,
      initialDelayMs: 1,
      jitter: false,
    });
    await runEither(withRetry(failingEffect(attempts, transportErr), policy));
    expect(attempts.count).toBe(1);
  });

  it("jitter stays within maxDelayMs hard cap", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn, delay, ...args) => {
        if (typeof delay === "number" && delay > 0) {
          delays.push(delay);
        }
        return originalSetTimeout(fn as () => void, 0, ...args);
      });

    try {
      const attempts = { count: 0 };
      const policy = exponentialRetry({
        maxAttempts: 20,
        initialDelayMs: 50,
        maxDelayMs: 50,
        factor: 2,
        jitter: true,
      });
      await runEither(withRetry(failingEffect(attempts, transportErr), policy));
      expect(delays.length).toBeGreaterThan(0);
      expect(Math.max(...delays)).toBeLessThanOrEqual(55);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("preserves success values without retry", async () => {
    const attempts = { count: 0 };
    const policy = exponentialRetry({
      maxAttempts: 3,
      initialDelayMs: 1,
      jitter: false,
    });
    const effect = Effect.sync(() => {
      attempts.count += 1;
      return 42;
    });
    const result = await runEither(withRetry(effect, policy));
    expect(attempts.count).toBe(1);
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).toBe(42);
    }
  });
});
