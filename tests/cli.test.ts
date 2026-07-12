import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  exitCodeForOperatorError,
  formatOperatorError,
  runWithCliErrors,
  writeOperatorError,
} from "../src/adapters/cli.js";
import {
  AuthError,
  ConfigError,
  NotFoundError,
  TimeoutError,
  TransportError,
  UnexpectedStatusError,
} from "../src/errors.js";

describe("formatOperatorError", () => {
  it("formats ConfigError using its message", () => {
    const error = new ConfigError({
      key: "API_KEY",
      message: "API_KEY is required",
    });
    const text = formatOperatorError(error);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("API_KEY");
  });

  it("formats TimeoutError without empty output", () => {
    const error = new TimeoutError({
      method: "GET",
      path: "/items",
      timeoutMs: 5000,
    });
    const text = formatOperatorError(error);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/TimeoutError|timeout|GET|\/items|5000/i);
  });

  it("does not dump secret-prone body from status errors", () => {
    const error = new AuthError({
      method: "GET",
      path: "/secure",
      status: 401,
      body: "Bearer super-secret-token",
    });
    const text = formatOperatorError(error);
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("Bearer");
  });

  it("does not dump TransportError cause payloads", () => {
    const error = new TransportError({
      method: "GET",
      path: "/x",
      cause: new Error("ECONNREFUSED api-key=leaked"),
    });
    const text = formatOperatorError(error);
    expect(text).not.toContain("api-key=leaked");
  });
});

describe("exitCodeForOperatorError", () => {
  it("returns 1 for all OperatorError tags (usage/exit 2 stays repo-owned)", () => {
    const samples = [
      new ConfigError({ message: "bad" }),
      new AuthError({ method: "GET", path: "/", status: 401 }),
      new NotFoundError({ method: "GET", path: "/", status: 404 }),
      new TimeoutError({ method: "GET", path: "/", timeoutMs: 1 }),
      new TransportError({ method: "GET", path: "/", cause: "net" }),
      new UnexpectedStatusError({
        method: "GET",
        path: "/",
        status: 500,
        body: "",
        expected: [200],
      }),
    ];
    for (const error of samples) {
      expect(exitCodeForOperatorError(error)).toBe(1);
    }
  });
});

describe("writeOperatorError", () => {
  it("writes a single formatted line via injectable stderr writer", () => {
    const err = vi.fn();
    const error = new ConfigError({ key: "X", message: "X is required" });
    writeOperatorError(error, err);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]![0]).toContain("X");
  });
});

describe("runWithCliErrors", () => {
  it("returns success value without writing stderr", async () => {
    const err = vi.fn();
    const outcome = await runWithCliErrors(Effect.succeed(42), { err });

    expect(outcome).toEqual({ ok: true, value: 42 });
    expect(err).not.toHaveBeenCalled();
  });

  it("maps OperatorError to exitCode 1 and writes formatted message", async () => {
    const err = vi.fn();
    const error = new NotFoundError({
      method: "GET",
      path: "/missing",
      status: 404,
      body: "secret-body",
    });
    const outcome = await runWithCliErrors(Effect.fail(error), { err });

    expect(outcome).toEqual({ ok: false, exitCode: 1 });
    expect(err).toHaveBeenCalledTimes(1);
    const line = String(err.mock.calls[0]![0]);
    expect(line.length).toBeGreaterThan(0);
    expect(line).not.toContain("secret-body");
  });

  it("allows custom formatError and exitCodeFor hooks", async () => {
    const err = vi.fn();
    const error = new ConfigError({ message: "nope", key: "K" });
    const outcome = await runWithCliErrors(Effect.fail(error), {
      err,
      formatError: (e) => `custom:${e._tag}`,
      exitCodeFor: () => 3,
    });

    expect(outcome).toEqual({ ok: false, exitCode: 3 });
    expect(err).toHaveBeenCalledWith("custom:ConfigError");
  });

  it("redacts bearer tokens from defect messages on stderr", async () => {
    const err = vi.fn();
    const outcome = await runWithCliErrors(
      Effect.die(
        new Error("upstream said Authorization: Bearer leak-me-now"),
      ) as Effect.Effect<number, never>,
      { err },
    );

    expect(outcome).toEqual({ ok: false, exitCode: 1 });
    expect(err).toHaveBeenCalledTimes(1);
    const line = String(err.mock.calls[0]![0]);
    expect(line).not.toContain("leak-me-now");
    expect(line).toContain("[REDACTED]");
  });
});
