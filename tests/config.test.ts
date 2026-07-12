import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ConfigError } from "../src/errors.js";
import {
  fromProcessEnv,
  normalizeBaseUrl,
  optionalString,
  parseBooleanEnv,
  parseNumberEnv,
  parsePositiveIntEnv,
  parseTimeoutEnv,
  requiredString,
  type EnvReader,
} from "../src/config.js";

const makeEnv = (record: Record<string, string | undefined>): EnvReader => ({
  get: (key) => record[key],
});

const runSuccess = <A>(effect: Effect.Effect<A, ConfigError>): Promise<A> =>
  Effect.runPromise(effect);

const runFailure = <E>(effect: Effect.Effect<unknown, E>): Promise<E> =>
  Effect.runPromise(effect.pipe(Effect.flip));

describe("fromProcessEnv", () => {
  it("reads values from an injected env object", () => {
    const env = fromProcessEnv({ FOO: "bar", BAZ: "qux" });
    expect(env.get("FOO")).toBe("bar");
    expect(env.get("BAZ")).toBe("qux");
  });

  it("returns undefined for missing keys", () => {
    const env = fromProcessEnv({});
    expect(env.get("MISSING")).toBeUndefined();
  });

  it("reads from process.env when no env object is provided", () => {
    const key = "EFFECT_OPERATOR_KIT_CONFIG_TEST_VAR";
    const previous = process.env[key];
    process.env[key] = "from-process";
    try {
      const env = fromProcessEnv();
      expect(env.get(key)).toBe("from-process");
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
});

describe("requiredString", () => {
  it("returns a trimmed value when present", async () => {
    const env = makeEnv({ API_KEY: "  secret  " });
    await expect(runSuccess(requiredString(env, "API_KEY"))).resolves.toBe("secret");
  });

  it("fails when the key is missing", async () => {
    const env = makeEnv({});
    const error = await runFailure(requiredString(env, "API_KEY"));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error._tag).toBe("ConfigError");
    expect(error.key).toBe("API_KEY");
    expect(error.message).toContain("API_KEY");
  });

  it("fails when the value is empty", async () => {
    const env = makeEnv({ API_KEY: "" });
    const error = await runFailure(requiredString(env, "API_KEY"));
    expect(error._tag).toBe("ConfigError");
    expect(error.key).toBe("API_KEY");
  });

  it("fails when the value is whitespace-only", async () => {
    const env = makeEnv({ API_KEY: "   " });
    const error = await runFailure(requiredString(env, "API_KEY"));
    expect(error._tag).toBe("ConfigError");
    expect(error.key).toBe("API_KEY");
  });
});

describe("optionalString", () => {
  it("returns a trimmed value when present", async () => {
    const env = makeEnv({ REGION: "  us-east  " });
    await expect(runSuccess(optionalString(env, "REGION"))).resolves.toBe("us-east");
  });

  it("returns fallback when missing", async () => {
    const env = makeEnv({});
    await expect(runSuccess(optionalString(env, "REGION", "default"))).resolves.toBe(
      "default",
    );
  });

  it("returns undefined when missing and no fallback is provided", async () => {
    const env = makeEnv({});
    await expect(runSuccess(optionalString(env, "REGION"))).resolves.toBeUndefined();
  });

  it("returns fallback when blank", async () => {
    const env = makeEnv({ REGION: "   " });
    await expect(runSuccess(optionalString(env, "REGION", "default"))).resolves.toBe(
      "default",
    );
  });

  it("never fails on invalid-looking input", async () => {
    const env = makeEnv({ REGION: "value" });
    await expect(runSuccess(optionalString(env, "REGION"))).resolves.toBe("value");
  });
});

describe("parseBooleanEnv", () => {
  const trueTokens = ["true", "TRUE", "1", "yes", "YES", "on", "ON"];
  const falseTokens = ["false", "FALSE", "0", "no", "NO", "off", "OFF"];

  it.each(trueTokens)("parses %s as true", async (token) => {
    const env = makeEnv({ FLAG: token });
    await expect(runSuccess(parseBooleanEnv(env, "FLAG", false))).resolves.toBe(true);
  });

  it.each(falseTokens)("parses %s as false", async (token) => {
    const env = makeEnv({ FLAG: token });
    await expect(runSuccess(parseBooleanEnv(env, "FLAG", true))).resolves.toBe(false);
  });

  it("returns fallback when missing", async () => {
    const env = makeEnv({});
    await expect(runSuccess(parseBooleanEnv(env, "FLAG", true))).resolves.toBe(true);
    await expect(runSuccess(parseBooleanEnv(env, "FLAG", false))).resolves.toBe(false);
  });

  it("returns fallback when blank", async () => {
    const env = makeEnv({ FLAG: "   " });
    await expect(runSuccess(parseBooleanEnv(env, "FLAG", true))).resolves.toBe(true);
  });

  it("fails on invalid values", async () => {
    const env = makeEnv({ FLAG: "maybe" });
    const error = await runFailure(parseBooleanEnv(env, "FLAG", false));
    expect(error._tag).toBe("ConfigError");
    expect(error.key).toBe("FLAG");
    expect(error.value).toBe("maybe");
  });
});

describe("parseNumberEnv", () => {
  it("returns fallback when missing and fallback is provided", async () => {
    const env = makeEnv({});
    await expect(
      runSuccess(parseNumberEnv(env, "PORT", { fallback: 8080 })),
    ).resolves.toBe(8080);
  });

  it("fails when missing and no fallback is provided", async () => {
    const env = makeEnv({});
    const error = await runFailure(parseNumberEnv(env, "PORT", {}));
    expect(error._tag).toBe("ConfigError");
    expect(error.key).toBe("PORT");
  });

  it("parses a valid number", async () => {
    const env = makeEnv({ PORT: "3000" });
    await expect(runSuccess(parseNumberEnv(env, "PORT", {}))).resolves.toBe(3000);
  });

  it("enforces min bound", async () => {
    const env = makeEnv({ PORT: "5" });
    const error = await runFailure(parseNumberEnv(env, "PORT", { min: 10 }));
    expect(error._tag).toBe("ConfigError");
    expect(error.key).toBe("PORT");
    expect(error.value).toBe("5");
  });

  it("enforces max bound", async () => {
    const env = makeEnv({ PORT: "9000" });
    const error = await runFailure(parseNumberEnv(env, "PORT", { max: 8080 }));
    expect(error._tag).toBe("ConfigError");
    expect(error.key).toBe("PORT");
    expect(error.value).toBe("9000");
  });

  it("fails on non-numeric input", async () => {
    const env = makeEnv({ PORT: "abc" });
    const error = await runFailure(parseNumberEnv(env, "PORT", {}));
    expect(error._tag).toBe("ConfigError");
    expect(error.value).toBe("abc");
  });

  it("fails on NaN and non-finite values", async () => {
    for (const value of ["NaN", "Infinity", "-Infinity"]) {
      const env = makeEnv({ PORT: value });
      const error = await runFailure(parseNumberEnv(env, "PORT", {}));
      expect(error._tag).toBe("ConfigError");
      expect(error.value).toBe(value);
    }
  });
});

describe("parsePositiveIntEnv", () => {
  it("parses a positive integer", async () => {
    const env = makeEnv({ RETRIES: "42" });
    await expect(runSuccess(parsePositiveIntEnv(env, "RETRIES"))).resolves.toBe(42);
  });

  it("rejects non-integers", async () => {
    const env = makeEnv({ RETRIES: "1.5" });
    const error = await runFailure(parsePositiveIntEnv(env, "RETRIES"));
    expect(error._tag).toBe("ConfigError");
    expect(error.value).toBe("1.5");
  });

  it("rejects zero", async () => {
    const env = makeEnv({ RETRIES: "0" });
    const error = await runFailure(parsePositiveIntEnv(env, "RETRIES"));
    expect(error._tag).toBe("ConfigError");
    expect(error.value).toBe("0");
  });

  it("rejects negative integers", async () => {
    const env = makeEnv({ RETRIES: "-1" });
    const error = await runFailure(parsePositiveIntEnv(env, "RETRIES"));
    expect(error._tag).toBe("ConfigError");
    expect(error.value).toBe("-1");
  });

  it("rejects non-numeric strings", async () => {
    const env = makeEnv({ RETRIES: "abc" });
    const error = await runFailure(parsePositiveIntEnv(env, "RETRIES"));
    expect(error._tag).toBe("ConfigError");
    expect(error.value).toBe("abc");
  });

  it("supports fallback, min, and max like parseNumberEnv", async () => {
    const missing = makeEnv({});
    await expect(
      runSuccess(parsePositiveIntEnv(missing, "RETRIES", { fallback: 3 })),
    ).resolves.toBe(3);

    const tooLow = makeEnv({ RETRIES: "2" });
    const minError = await runFailure(
      parsePositiveIntEnv(tooLow, "RETRIES", { min: 5 }),
    );
    expect(minError._tag).toBe("ConfigError");

    const tooHigh = makeEnv({ RETRIES: "20" });
    const maxError = await runFailure(
      parsePositiveIntEnv(tooHigh, "RETRIES", { max: 10 }),
    );
    expect(maxError._tag).toBe("ConfigError");
  });
});

describe("parseTimeoutEnv", () => {
  it("returns fallbackMs when blank", async () => {
    const env = makeEnv({});
    await expect(
      runSuccess(parseTimeoutEnv(env, "TIMEOUT", { fallbackMs: 15_000 })),
    ).resolves.toBe(15_000);
  });

  it("parses seconds by default", async () => {
    const env = makeEnv({ TIMEOUT: "30" });
    await expect(
      runSuccess(parseTimeoutEnv(env, "TIMEOUT", { fallbackMs: 5_000 })),
    ).resolves.toBe(30_000);
  });

  it("parses milliseconds when unit is ms", async () => {
    const env = makeEnv({ TIMEOUT: "5000" });
    await expect(
      runSuccess(
        parseTimeoutEnv(env, "TIMEOUT", { fallbackMs: 1_000, unit: "ms" }),
      ),
    ).resolves.toBe(5_000);
  });

  it("fails on zero, negative, and non-numeric values", async () => {
    for (const value of ["0", "-5", "abc"]) {
      const env = makeEnv({ TIMEOUT: value });
      const error = await runFailure(
        parseTimeoutEnv(env, "TIMEOUT", { fallbackMs: 1_000 }),
      );
      expect(error._tag).toBe("ConfigError");
      expect(error.key).toBe("TIMEOUT");
      expect(error.value).toBe(value);
    }
  });

  it("enforces minMs on the returned millisecond value", async () => {
    const env = makeEnv({ TIMEOUT: "1" });
    const error = await runFailure(
      parseTimeoutEnv(env, "TIMEOUT", { fallbackMs: 5_000, minMs: 2_000 }),
    );
    expect(error._tag).toBe("ConfigError");
    expect(error.value).toBe("1");
  });

  it("enforces maxMs on the returned millisecond value", async () => {
    const env = makeEnv({ TIMEOUT: "60" });
    const error = await runFailure(
      parseTimeoutEnv(env, "TIMEOUT", { fallbackMs: 5_000, maxMs: 30_000 }),
    );
    expect(error._tag).toBe("ConfigError");
    expect(error.value).toBe("60");
  });
});

describe("normalizeBaseUrl", () => {
  it("returns a URL instance", () => {
    const url = normalizeBaseUrl("https://api.example.com/v1/");
    expect(url).toBeInstanceOf(URL);
  });

  it("strips trailing slashes from the pathname by default", () => {
    const url = normalizeBaseUrl("https://api.example.com/v1/");
    expect(url.href).toBe("https://api.example.com/v1");
    expect(url.pathname).toBe("/v1");
  });

  it("preserves trailing slashes when stripTrailingSlash is false", () => {
    const url = normalizeBaseUrl("https://api.example.com/v1/", {
      stripTrailingSlash: false,
    });
    expect(url.pathname).toBe("/v1/");
  });

  it("appends ensurePath when the segment is absent", () => {
    const url = normalizeBaseUrl("https://api.example.com", { ensurePath: "v1" });
    expect(url.pathname).toBe("/v1");
  });

  it("normalizes a leading slash on ensurePath", () => {
    const url = normalizeBaseUrl("https://api.example.com", { ensurePath: "/v1" });
    expect(url.pathname).toBe("/v1");
  });

  it("does not double-append ensurePath when already present", () => {
    const url = normalizeBaseUrl("https://api.example.com/v1", { ensurePath: "v1" });
    expect(url.pathname).toBe("/v1");
  });

  it("throws TypeError for invalid URLs", () => {
    expect(typeof normalizeBaseUrl).toBe("function");
    expect(() => normalizeBaseUrl("not-a-url")).toThrow();
  });
});
