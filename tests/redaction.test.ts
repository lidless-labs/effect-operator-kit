import { describe, expect, it } from "vitest";
import {
  defaultRedact,
  redactString,
  type RedactFn,
} from "../src/redaction.js";

/** Sample JWT-shaped token (three base64url segments; not a real credential). */
const SAMPLE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart";

describe("redactString — identity and purity", () => {
  it("leaves plain text under 500 chars unchanged", () => {
    const msg = "connection refused to host.example:443";
    expect(redactString(msg)).toBe(msg);
  });

  it("is pure (same input → same output)", () => {
    const msg = "Bearer abc.def.ghi and token=xyz";
    expect(redactString(msg)).toBe(redactString(msg));
  });
});

describe("redactString — bearer / basic auth", () => {
  it("redacts Authorization: Bearer header form, keeps scheme", () => {
    const raw = "Authorization: Bearer super-secret-token-value";
    const out = redactString(raw);
    expect(out.toLowerCase()).toContain("authorization:");
    expect(out.toLowerCase()).toContain("bearer");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("super-secret-token-value");
  });

  it("redacts Authorization: Basic header form, keeps scheme", () => {
    const raw = "Authorization: Basic dXNlcjpwYXNz";
    const out = redactString(raw);
    expect(out.toLowerCase()).toContain("authorization:");
    expect(out.toLowerCase()).toContain("basic");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("dXNlcjpwYXNz");
  });

  it("redacts bare Bearer tokens", () => {
    const raw = "got Bearer tok_abc123XYZ while calling API";
    const out = redactString(raw);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("tok_abc123XYZ");
    expect(out.toLowerCase()).toContain("bearer");
  });

  it("redacts bare Basic credentials", () => {
    const raw = "upstream said Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
    const out = redactString(raw);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
  });
});

describe("redactString — URL credentials", () => {
  it("redacts userinfo in https URLs", () => {
    const raw = "failed fetch https://alice:s3cret@api.example.com/v1/items";
    const out = redactString(raw);
    expect(out).toContain("https://");
    expect(out).toContain("[REDACTED]:[REDACTED]@");
    expect(out).toContain("api.example.com/v1/items");
    expect(out).not.toContain("alice");
    expect(out).not.toContain("s3cret");
  });

  it("redacts userinfo in http URLs", () => {
    const raw = "proxy http://user:pass@localhost:8080/path";
    const out = redactString(raw);
    expect(out).toContain("[REDACTED]:[REDACTED]@");
    expect(out).not.toContain("user:pass");
  });
});

describe("redactString — query-param secrets", () => {
  it("redacts password, token, secret, api_key, and key query values", () => {
    const raw =
      "GET /x?token=tkn123&api_key=key456&password=p@ss&secret=shh&key=k9&safe=ok";
    const out = redactString(raw);
    expect(out).not.toContain("tkn123");
    expect(out).not.toContain("key456");
    expect(out).not.toContain("p@ss");
    expect(out).not.toContain("shh");
    expect(out).not.toContain("k9");
    expect(out).toContain("token=[REDACTED]");
    expect(out).toContain("api_key=[REDACTED]");
    expect(out).toContain("password=[REDACTED]");
    expect(out).toContain("secret=[REDACTED]");
    expect(out).toContain("key=[REDACTED]");
    expect(out).toContain("safe=ok");
  });

  it("redacts api-key and apikey variants", () => {
    const raw = "url?api-key=dash-val&apikey=compact";
    const out = redactString(raw);
    expect(out).not.toContain("dash-val");
    expect(out).not.toContain("compact");
    expect(out).toContain("[REDACTED]");
  });
});

describe("redactString — JWTs", () => {
  it("redacts three-segment JWT-looking tokens", () => {
    const raw = `Authorization failed for ${SAMPLE_JWT}`;
    const out = redactString(raw);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(out).not.toContain(SAMPLE_JWT);
  });
});

describe("redactString — explicit secrets list", () => {
  it("replaces listed secrets even when they do not match regexes", () => {
    const raw = "config loaded with my-literal-secret-value for service";
    const out = redactString(raw, ["my-literal-secret-value"]);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("my-literal-secret-value");
  });

  it("ignores empty secret strings", () => {
    const raw = "plain message";
    expect(redactString(raw, ["", "  "])).toBe(raw);
  });
});

describe("redactString — truncation at 500 chars", () => {
  it("does not truncate messages of length 500", () => {
    const raw = "a".repeat(500);
    expect(redactString(raw)).toBe(raw);
    expect(redactString(raw).length).toBe(500);
  });

  it("truncates to 500 chars plus ellipsis when longer than 500", () => {
    const raw = "b".repeat(501);
    const out = redactString(raw);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBe(503); // 500 + "..."
    expect(out.slice(0, 500)).toBe("b".repeat(500));
  });

  it("truncates after redaction (post-sanitize length)", () => {
    const prefix = "x".repeat(480);
    const raw = `${prefix} Bearer supersecrettokenvalue12345 and more padding text here!!!`;
    const out = redactString(raw);
    expect(out.length).toBeLessThanOrEqual(503);
    if (out.length > 500) {
      expect(out.endsWith("...")).toBe(true);
    }
    expect(out).not.toContain("supersecrettokenvalue12345");
  });
});

describe("redact hook behavior", () => {
  it("exports RedactFn compatible with (value: string) => string", () => {
    const hook: RedactFn = defaultRedact;
    const out = hook("Bearer abcdefghijklmnop");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("abcdefghijklmnop");
  });

  it("defaultRedact matches redactString with no secrets", () => {
    const samples = [
      "ok",
      "Bearer tok123",
      "https://u:p@h/x?token=abc",
      SAMPLE_JWT,
      "a".repeat(600),
    ];
    for (const s of samples) {
      expect(defaultRedact(s)).toBe(redactString(s));
    }
  });

  it("can be used as an injectable HttpContext-style redact hook", () => {
    const redact: RedactFn = (value) => redactString(value, ["extra-secret"]);
    const body = "leak extra-secret in body";
    expect(redact(body)).not.toContain("extra-secret");
    expect(redact(body)).toContain("[REDACTED]");
  });
});

describe("redactString — multi-pattern messages", () => {
  it("redacts bearer and JWT in the same string", () => {
    const raw = `Authorization: Bearer tok_live_xyz JWT=${SAMPLE_JWT}`;
    const out = redactString(raw);
    expect(out).not.toContain("tok_live_xyz");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts URL credentials and query secrets together", () => {
    const raw =
      "retry https://admin:hunter2@host.example/api?api_key=abc&token=def failed";
    const out = redactString(raw);
    expect(out).not.toContain("admin");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("def");
    expect(out).toContain("[REDACTED]");
  });
});
