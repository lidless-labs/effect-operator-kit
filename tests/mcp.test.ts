import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  operatorErrorMessage,
  runAsMcpTool,
  toMcpResult,
  toToolHandler,
} from "../src/adapters/mcp.js";
import {
  AuthError,
  ConfigError,
  NotFoundError,
  TimeoutError,
} from "../src/errors.js";
import { fail, ok, type McpTextResult } from "../src/result.js";

const GHP_TOKEN = "ghp_abcdefghijklmnop";
const N8N_KEY = "n8n-secret-key-value";

function parseText(result: McpTextResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("operatorErrorMessage", () => {
  it("uses message from ConfigError", () => {
    const error = new ConfigError({ key: "API_KEY", message: "API_KEY is required" });
    expect(operatorErrorMessage(error)).toBe("API_KEY is required");
  });

  it("builds a thin message for status errors without dumping body", () => {
    const error = new NotFoundError({
      method: "GET",
      path: "/items/1",
      status: 404,
      body: "secret-token-should-not-appear",
    });
    const message = operatorErrorMessage(error);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("secret-token-should-not-appear");
  });

  it("uses Error.message for plain Errors", () => {
    expect(operatorErrorMessage(new Error("transform boom"))).toBe("transform boom");
  });
});

describe("toMcpResult / runAsMcpTool", () => {
  it("passes through successful McpTextResult unchanged", async () => {
    const success = ok({ x: 1 });
    const result = await runAsMcpTool(Effect.succeed(success));

    expect(result).toEqual(success);
    expect(result.isError).toBeUndefined();
    expect(parseText(result)).toEqual({ x: 1 });
  });

  it("maps OperatorError fail channel to fail() text shape", async () => {
    const error = new NotFoundError({
      method: "GET",
      path: "/users/missing",
      status: 404,
      body: "raw-body-leak",
    });
    const result = await runAsMcpTool(Effect.fail(error));

    expect(result.isError).toBe(true);
    const body = parseText(result);
    expect(body).toHaveProperty("error");
    expect(String(body.error).length).toBeGreaterThan(0);
    expect(String(body.error)).not.toContain("raw-body-leak");
  });

  it("maps AuthError to isError fail shape", async () => {
    const error = new AuthError({
      method: "GET",
      path: "/secure",
      status: 401,
      body: "Authorization: Bearer secret",
    });
    const result = await Effect.runPromise(toMcpResult(Effect.fail(error)));

    expect(result.isError).toBe(true);
    expect(String(parseText(result).error)).not.toContain("Bearer secret");
  });

  it("captures defects after success path (post-call transform throw)", async () => {
    const effect = Effect.succeed(ok({ TotalRecordCount: 1 })).pipe(
      Effect.map(() => {
        throw new Error("Cannot read properties of undefined (reading 'map')");
      }),
    );

    const result = await runAsMcpTool(effect as Effect.Effect<McpTextResult, never>);

    expect(result.isError).toBe(true);
    expect(String(parseText(result).error)).toContain("map");
  });

  it("captures Effect.die defects as fail()", async () => {
    const result = await runAsMcpTool(
      Effect.die(new Error("unexpected defect")) as Effect.Effect<McpTextResult, never>,
    );

    expect(result.isError).toBe(true);
    expect(String(parseText(result).error)).toContain("unexpected defect");
  });

  it("redacts bearer tokens from defect messages in fail() output", async () => {
    const result = await runAsMcpTool(
      Effect.die(
        new Error("upstream Bearer mcp-leak-token while processing"),
      ) as Effect.Effect<McpTextResult, never>,
    );

    expect(result.isError).toBe(true);
    const message = String(parseText(result).error);
    expect(message).not.toContain("mcp-leak-token");
    expect(message).toContain("[REDACTED]");
  });

  it("never rejects the promise on OperatorError", async () => {
    const error = new TimeoutError({
      method: "GET",
      path: "/slow",
      timeoutMs: 1000,
    });
    await expect(runAsMcpTool(Effect.fail(error))).resolves.toMatchObject({
      isError: true,
    });
  });

  it("never leaks ghp_ URL tokens or X-N8N-API-KEY header values in fail output", async () => {
    const error = new ConfigError({
      message: `failed https://${GHP_TOKEN}@github.com with X-N8N-API-KEY: ${N8N_KEY}`,
    });
    const result = await runAsMcpTool(Effect.fail(error));

    expect(result.isError).toBe(true);
    const message = String(parseText(result).error);
    expect(message).not.toContain(GHP_TOKEN);
    expect(message).not.toContain(N8N_KEY);
    expect(message).toContain("[REDACTED]");
  });
});

describe("toToolHandler", () => {
  it("runs a successful handler to McpTextResult", async () => {
    const handler = toToolHandler((args: { id: string }) =>
      Effect.succeed(ok({ id: args.id })),
    );
    const result = await handler({ id: "u1" });

    expect(result.isError).toBeUndefined();
    expect(parseText(result)).toEqual({ id: "u1" });
  });

  it("maps handler OperatorError to fail shape without rejecting", async () => {
    const handler = toToolHandler(() =>
      Effect.fail(
        new ConfigError({ key: "URL", message: "URL is required" }),
      ),
    );
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(parseText(result)).toEqual({ error: "URL is required" });
  });

  it("catches outer sync throws before Effect runs", async () => {
    const handler = toToolHandler(() => {
      throw new Error("sync setup failed");
    });

    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(String(parseText(result).error)).toContain("sync setup failed");
  });

  it("redacts bearer tokens from sync-throw messages in fail() output", async () => {
    const handler = toToolHandler(() => {
      throw new Error("sync Bearer sync-throw-token leaked");
    });

    const result = await handler({});
    expect(result.isError).toBe(true);
    const message = String(parseText(result).error);
    expect(message).not.toContain("sync-throw-token");
    expect(message).toContain("[REDACTED]");
  });

  it("never rejects on defect inside handler Effect", async () => {
    const handler = toToolHandler(() =>
      Effect.succeed(ok({ ok: true })).pipe(
        Effect.map(() => {
          throw new Error("post-success transform");
        }),
      ) as Effect.Effect<McpTextResult, never>,
    );

    await expect(handler({})).resolves.toMatchObject({ isError: true });
    const result = await handler({});
    expect(String(parseText(result).error)).toContain("post-success transform");
  });
});
