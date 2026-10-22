import { describe, expect, it } from "vitest";
import {
  ADDITIVE,
  DESTRUCTIVE,
  READ_ONLY,
  UPDATE,
  annotate,
  annotationsForTier,
  annotationsFromTiers,
  assertNoDrift,
  assertToolAnnotations,
  auditToolAnnotations,
  looksMutating,
  recordToolAnnotations,
  type ToolAnnotations,
  type ToolTier,
} from "../src/annotations.js";

describe("presets", () => {
  it("sets every boolean hint explicitly on all four tiers", () => {
    for (const preset of [READ_ONLY, ADDITIVE, UPDATE, DESTRUCTIVE]) {
      for (const key of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof preset[key], key).toBe("boolean");
      }
    }
  });

  it("matches the jellyctrl three-tier model", () => {
    expect(READ_ONLY).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(ADDITIVE).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(DESTRUCTIVE).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("distinguishes additive from update by idempotency", () => {
    expect(ADDITIVE.idempotentHint).toBe(false);
    expect(UPDATE).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(READ_ONLY.idempotentHint).toBe(true);
    expect(DESTRUCTIVE.idempotentHint).toBe(false);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(READ_ONLY)).toBe(true);
    expect(Object.isFrozen(annotationsForTier("update", { title: "x" }))).toBe(true);
  });
});

describe("annotationsForTier", () => {
  it("carries title, idempotent and openWorld overrides", () => {
    expect(
      annotationsForTier("additive", { title: "Create user", idempotent: true, openWorld: true }),
    ).toEqual({
      title: "Create user",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("omits title when none is given", () => {
    expect("title" in READ_ONLY).toBe(false);
  });

  it("fails closed on an unknown tier", () => {
    const annotations = annotationsForTier("bogus" as ToolTier);
    expect(annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("fails closed on inherited Object.prototype keys", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const annotations = annotationsForTier(name as ToolTier);
      expect(annotations, name).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
  });
});

describe("annotate", () => {
  it("defaults to destructive for an empty spec", () => {
    expect(annotate()).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotate({})).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("treats a write without an opt-out as destructive", () => {
    expect(annotate({ title: "Delete user" })).toMatchObject({
      title: "Delete user",
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(annotate({ readOnly: false })).toMatchObject({ destructiveHint: true });
  });

  it("only readOnly: true yields readOnlyHint true", () => {
    expect(annotate({ readOnly: true })).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it("lets a write opt out of the default per tool", () => {
    expect(annotate({ destructive: false })).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(annotate({ destructive: false, idempotent: true })).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it("rejects readOnly together with destructive", () => {
    expect(() => annotate({ readOnly: true, destructive: true })).toThrow(/both readOnly and destructive/);
  });

  it("ignores destructive: false on a read-only tool", () => {
    expect(annotate({ readOnly: true, destructive: false })).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });
});

describe("assertNoDrift", () => {
  const tiers: Record<string, ToolTier> = { get_item: "read", delete_item: "destructive" };

  it("passes when registry and tiers agree", () => {
    expect(() => assertNoDrift(["delete_item", "get_item"], tiers)).not.toThrow();
  });

  it("fails on a registered tool without a tier", () => {
    expect(() => assertNoDrift(["get_item", "delete_item", "new_tool"], tiers)).toThrow(
      /registered without a tier: new_tool/,
    );
  });

  it("fails on a tier entry for a tool that is no longer registered", () => {
    expect(() => assertNoDrift(["get_item"], tiers)).toThrow(
      /unregistered tools: delete_item/,
    );
  });

  it("fails on an unknown tier value", () => {
    expect(() =>
      assertNoDrift(["a"], { a: "writey" as ToolTier }),
    ).toThrow(/unknown tier for: a/);
  });

  it("does not treat Object.prototype keys as classified", () => {
    expect(() => assertNoDrift(["toString"], {})).toThrow(/registered without a tier: toString/);
  });

  it("reports every problem in one error", () => {
    expect(() => assertNoDrift(["a"], { b: "read" })).toThrow(
      /registered without a tier: a; tier entries for unregistered tools: b/,
    );
  });
});

describe("annotationsFromTiers", () => {
  it("builds a name to annotations map with per-tool options", () => {
    const map = annotationsFromTiers(
      { get_item: "read", delete_item: "destructive" },
      { delete_item: { title: "Delete item" } },
    );
    expect(map.get_item).toEqual(READ_ONLY);
    expect(map.delete_item).toMatchObject({ title: "Delete item", destructiveHint: true });
  });
});

describe("looksMutating", () => {
  it.each([
    "jellyfin_delete_user",
    "proxmox_stop_resource",
    "n8n_exec_workflow",
    "write_file",
    "resetPassword",
    "kill-session",
  ])("flags %s", (name) => {
    expect(looksMutating(name)).toBe(true);
  });

  it.each(["get_item", "list_users", "stopwatch_status", "overwritten_flags", "executor_info"])(
    "does not flag %s",
    (name) => {
      expect(looksMutating(name)).toBe(false);
    },
  );
});

describe("auditToolAnnotations", () => {
  const tools = (entries: Array<[string, ToolAnnotations | undefined]>) => new Map(entries);

  it("is clean for a sound registry", () => {
    expect(
      auditToolAnnotations(
        tools([
          ["get_item", READ_ONLY],
          ["create_item", ADDITIVE],
          ["delete_item", DESTRUCTIVE],
        ]),
      ),
    ).toEqual([]);
  });

  it("flags a tool with no annotations", () => {
    expect(auditToolAnnotations(tools([["get_item", undefined]]))).toEqual([
      "get_item: no annotations",
    ]);
  });

  it("flags missing readOnlyHint and destructiveHint", () => {
    expect(auditToolAnnotations(tools([["get_item", { title: "Get" }]]))).toEqual([
      "get_item: readOnlyHint is not set",
      "get_item: destructiveHint is not set",
    ]);
  });

  it("flags a write that only sets readOnlyHint false (Executor would not prompt)", () => {
    const problems = auditToolAnnotations(tools([["save_thing", { readOnlyHint: false }]]));
    expect(problems).toEqual(["save_thing: destructiveHint is not set"]);
  });

  it("flags a mutating-looking name that is not destructive", () => {
    expect(auditToolAnnotations(tools([["delete_item", ADDITIVE]]))).toEqual([
      "delete_item: name looks like a mutation but destructiveHint is not true",
    ]);
  });

  it("honors allowNonDestructive for deliberate exceptions", () => {
    expect(
      auditToolAnnotations(tools([["preview_reset", READ_ONLY]]), {
        allowNonDestructive: ["preview_reset"],
      }),
    ).toEqual([]);
  });

  it("flags readOnly and destructive both true", () => {
    expect(
      auditToolAnnotations(tools([["get_item", { readOnlyHint: true, destructiveHint: true }]])),
    ).toEqual(["get_item: readOnlyHint and destructiveHint are both true"]);
  });

  it("assertToolAnnotations throws one error listing every problem", () => {
    expect(() =>
      assertToolAnnotations(tools([["a", undefined], ["delete_b", ADDITIVE]])),
    ).toThrow(/a: no annotations[\s\S]*delete_b: name looks like a mutation/);
  });
});

describe("recordToolAnnotations", () => {
  it("records annotations from the positional server.tool signature", () => {
    const { server, tools } = recordToolAnnotations();
    server.tool("a", "desc", { id: "schema" }, READ_ONLY, async () => ({}));
    server.tool("b", "desc", DESTRUCTIVE, async () => ({}));
    server.tool("c", "desc", { id: "schema" }, async () => ({}));
    expect(tools.get("a")).toBe(READ_ONLY);
    expect(tools.get("b")).toBe(DESTRUCTIVE);
    expect(tools.has("c")).toBe(true);
    expect(tools.get("c")).toBeUndefined();
  });

  it("does not mistake an input schema field named like a hint for the annotations", () => {
    const { server, tools } = recordToolAnnotations();
    const schema = { readOnlyHint: { _def: "zod-boolean-like" } };
    server.tool("a", "desc", schema, DESTRUCTIVE, async () => ({}));
    server.tool("b", "desc", schema, async () => ({}));
    expect(tools.get("a")).toBe(DESTRUCTIVE);
    expect(tools.get("b")).toBeUndefined();
  });

  it("ignores inherited hint values", () => {
    const { server, tools } = recordToolAnnotations();
    const inherited = Object.create({ readOnlyHint: true, destructiveHint: false });
    server.tool("a", "desc", inherited, async () => ({}));
    expect(tools.get("a")).toBeUndefined();
  });

  it("records annotations from registerTool config", () => {
    const { server, tools } = recordToolAnnotations();
    server.registerTool("a", { annotations: UPDATE });
    server.registerTool("b", {});
    expect(tools.get("a")).toBe(UPDATE);
    expect(tools.get("b")).toBeUndefined();
  });

  it("composes with assertToolAnnotations", () => {
    const { server, tools } = recordToolAnnotations();
    server.tool("get_item", "d", {}, READ_ONLY, () => undefined);
    server.tool("remove_item", "d", {}, ADDITIVE, () => undefined);
    expect(() => assertToolAnnotations(tools)).toThrow(/remove_item/);
  });
});
