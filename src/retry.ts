import { Duration, Effect, Schedule } from "effect";
import type { OperatorError } from "./errors.js";

export interface RetryPolicy {
  enabled: boolean;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: boolean;
  shouldRetry: (error: OperatorError) => boolean;
}

/** Default retry predicate: transport, timeout, and 5xx unexpected status only. */
const defaultShouldRetry = (error: OperatorError): boolean => {
  switch (error._tag) {
    case "TransportError":
    case "TimeoutError":
      return true;
    case "UnexpectedStatusError":
      return error.status >= 500;
    default:
      return false;
  }
};

const DEFAULT_POLICY_FIELDS = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 5_000,
  factor: 2,
  jitter: true,
  shouldRetry: defaultShouldRetry,
} as const satisfies Omit<RetryPolicy, "enabled">;

/**
 * Disabled-by-default policy. `withRetry(effect)` and `withRetry(effect, noRetry)`
 * both run the effect once with no backoff.
 */
export const noRetry: RetryPolicy = {
  enabled: false,
  ...DEFAULT_POLICY_FIELDS,
  shouldRetry: () => false,
};

/**
 * Enabled exponential-backoff factory. Partial overrides merge onto kit defaults.
 * Callers must pass this (or another enabled policy) to opt into retries.
 */
export const exponentialRetry = (opts: Partial<RetryPolicy>): RetryPolicy => ({
  enabled: opts.enabled ?? true,
  maxAttempts: opts.maxAttempts ?? DEFAULT_POLICY_FIELDS.maxAttempts,
  initialDelayMs: opts.initialDelayMs ?? DEFAULT_POLICY_FIELDS.initialDelayMs,
  maxDelayMs: opts.maxDelayMs ?? DEFAULT_POLICY_FIELDS.maxDelayMs,
  factor: opts.factor ?? DEFAULT_POLICY_FIELDS.factor,
  jitter: opts.jitter ?? DEFAULT_POLICY_FIELDS.jitter,
  shouldRetry: opts.shouldRetry ?? DEFAULT_POLICY_FIELDS.shouldRetry,
});

const buildSchedule = (policy: RetryPolicy): Schedule.Schedule<Duration.Duration, OperatorError> => {
  const base = Schedule.exponential(`${policy.initialDelayMs} millis`, policy.factor).pipe(
    Schedule.modifyDelay((_out, duration) => {
      const ms = Duration.toMillis(duration);
      return ms > policy.maxDelayMs ? `${policy.maxDelayMs} millis` : duration;
    }),
  );

  const withJitter = policy.jitter ? base.pipe(Schedule.jittered) : base;

  // Schedule input is the failure value; stop when shouldRetry is false.
  return withJitter.pipe(Schedule.whileInput((error: OperatorError) => policy.shouldRetry(error)));
};

/**
 * Run `effect` under an optional retry policy.
 * - No policy / disabled policy → single attempt (disabled by default).
 * - `maxAttempts` is total tries (1 = no retry after first failure).
 * - Uses Effect Schedule for exponential backoff between attempts.
 */
export const withRetry = <A>(
  effect: Effect.Effect<A, OperatorError>,
  policy: RetryPolicy = noRetry,
): Effect.Effect<A, OperatorError> => {
  if (!policy.enabled || policy.maxAttempts <= 1) {
    return effect;
  }

  const retries = Math.max(0, policy.maxAttempts - 1);

  return Effect.retry(effect, {
    times: retries,
    while: (error) => policy.shouldRetry(error),
    schedule: buildSchedule(policy),
  });
};
