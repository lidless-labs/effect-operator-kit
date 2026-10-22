/**
 * Typed MCP tool annotations with a fail-closed default.
 *
 * Executor v2 prompts a person only when `destructiveHint === true`, and the
 * MCP spec default for an unset `destructiveHint` is also `true`, so a tool
 * with no explicit hints is an unreviewed write. This module makes every tool
 * declare its tier, and treats anything not explicitly read-only as
 * destructive unless the app opts out per tool.
 *
 * The shape is structurally compatible with the MCP SDK `ToolAnnotations`
 * type; the kit does not import the SDK.
 */

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Four tiers. `read` never changes state. `additive` creates or sends and is
 * not idempotent. `update` changes existing state and is safe to repeat.
 * `destructive` deletes, resets, stops or otherwise loses state or disrupts a
 * running system, and is the only tier that prompts under Executor v2.
 */
export type ToolTier = "read" | "additive" | "update" | "destructive";

export interface AnnotationOptions {
  /** Human-readable tool title. */
  title?: string;
  /** Override the tier's idempotency default. */
  idempotent?: boolean;
  /**
   * Whether the tool reaches entities outside the one configured service.
   * Defaults to false: ctrl apps talk to a single configured backend.
   */
  openWorld?: boolean;
}

const build = (
  base: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean },
  options: AnnotationOptions,
): ToolAnnotations => {
  const annotations: ToolAnnotations = {};
  if (options.title !== undefined) annotations.title = options.title;
  annotations.readOnlyHint = base.readOnlyHint;
  annotations.destructiveHint = base.destructiveHint;
  annotations.idempotentHint = options.idempotent ?? base.idempotentHint;
  annotations.openWorldHint = options.openWorld ?? false;
  return Object.freeze(annotations);
};

const TIER_BASES = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  additive: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  update: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
} as const satisfies Record<ToolTier, unknown>;

/** Annotations for a tier. Always sets all four boolean hints explicitly. */
export const annotationsForTier = (
  tier: ToolTier,
  options: AnnotationOptions = {},
): ToolAnnotations => {
  // Own-property check: an inherited key such as "constructor" must not count as a tier.
  if (!Object.hasOwn(TIER_BASES, tier)) {
    // A cast or untyped caller can pass anything; fail closed.
    return annotationsForTier("destructive", options);
  }
  return build(TIER_BASES[tier], options);
};

/** Ready-made tier presets with no title. Frozen; use the functions to add one. */
export const READ_ONLY: ToolAnnotations = annotationsForTier("read");
/** Non-destructive write that creates or sends (jellyctrl `NON_DESTRUCTIVE`). */
export const ADDITIVE: ToolAnnotations = annotationsForTier("additive");
/** Non-destructive write to existing state that is safe to repeat. */
export const UPDATE: ToolAnnotations = annotationsForTier("update");
export const DESTRUCTIVE: ToolAnnotations = annotationsForTier("destructive");

export interface ToolAnnotationSpec extends AnnotationOptions {
  /** Explicitly read-only. The only way to get `readOnlyHint: true`. */
  readOnly?: boolean;
  /**
   * Per-tool opt-out of the destructive default for a write. Set `false` for
   * a write that creates, sends or updates without losing state. Ignored (and
   * rejected when `true`) alongside `readOnly`.
   */
  destructive?: boolean;
}

/**
 * Declare a tool's annotations from intent. Safe by default: an empty spec,
 * or any write that does not say `destructive: false`, is
 * `readOnlyHint: false, destructiveHint: true`.
 */
export const annotate = (spec: ToolAnnotationSpec = {}): ToolAnnotations => {
  const { readOnly, destructive, ...options } = spec;
  if (readOnly === true) {
    if (destructive === true) {
      throw new Error("annotate: a tool cannot be both readOnly and destructive");
    }
    return annotationsForTier("read", options);
  }
  if (destructive === false) {
    return annotationsForTier(options.idempotent === true ? "update" : "additive", options);
  }
  return annotationsForTier("destructive", options);
};

/**
 * Fail-closed registry check. Every registered tool must have a tier, and
 * every tier entry must name a registered tool, so a new or renamed tool
 * cannot ship unclassified. Throws one error listing every mismatch.
 */
export const assertNoDrift = (
  registered: Iterable<string>,
  tiers: Readonly<Record<string, ToolTier>>,
): void => {
  const names = new Set(registered);
  const unclassified = [...names].filter((name) => !Object.hasOwn(tiers, name)).sort();
  const stale = Object.keys(tiers)
    .filter((name) => !names.has(name))
    .sort();
  const invalid = Object.entries(tiers)
    .filter(([, tier]) => !Object.hasOwn(TIER_BASES, tier))
    .map(([name]) => name)
    .sort();
  const problems: string[] = [];
  if (unclassified.length > 0) problems.push(`registered without a tier: ${unclassified.join(", ")}`);
  if (stale.length > 0) problems.push(`tier entries for unregistered tools: ${stale.join(", ")}`);
  if (invalid.length > 0) problems.push(`unknown tier for: ${invalid.join(", ")}`);
  if (problems.length > 0) {
    throw new Error(`Tool tier drift: ${problems.join("; ")}`);
  }
};

/** Tier registry to annotations map, for registering from one table. */
export const annotationsFromTiers = (
  tiers: Readonly<Record<string, ToolTier>>,
  options: Readonly<Record<string, AnnotationOptions>> = {},
): Record<string, ToolAnnotations> =>
  Object.fromEntries(
    Object.entries(tiers).map(([name, tier]) => [name, annotationsForTier(tier, options[name])]),
  );

const MUTATING_TOKENS = new Set([
  "delete",
  "destroy",
  "drop",
  "erase",
  "exec",
  "execute",
  "kill",
  "purge",
  "remove",
  "reset",
  "restart",
  "revoke",
  "shutdown",
  "stop",
  "wipe",
  "write",
]);

const nameTokens = (name: string): string[] =>
  name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter((token) => token.length > 0);

/** True when a tool name reads like a delete, reset, stop, exec or write. */
export const looksMutating = (name: string): boolean =>
  nameTokens(name).some((token) => MUTATING_TOKENS.has(token));

export interface AnnotationAuditOptions {
  /**
   * Tools whose name looks mutating but are deliberately not destructive
   * (for example a preview or dry-run tool that is read-only).
   */
  allowNonDestructive?: Iterable<string>;
}

/**
 * Audit registered tools. Returns one message per problem; empty means clean.
 * Flags a tool with no annotations, a missing `readOnlyHint` or
 * `destructiveHint`, a `readOnlyHint: true` tool that also says destructive,
 * and a mutating-looking name that is not `destructiveHint: true`.
 */
export const auditToolAnnotations = (
  tools: ReadonlyMap<string, ToolAnnotations | undefined>,
  options: AnnotationAuditOptions = {},
): string[] => {
  const allowed = new Set(options.allowNonDestructive ?? []);
  const problems: string[] = [];
  for (const [name, annotations] of [...tools].sort(([a], [b]) => a.localeCompare(b))) {
    if (annotations === undefined) {
      problems.push(`${name}: no annotations`);
      continue;
    }
    if (typeof annotations.readOnlyHint !== "boolean") {
      problems.push(`${name}: readOnlyHint is not set`);
    }
    if (typeof annotations.destructiveHint !== "boolean") {
      problems.push(`${name}: destructiveHint is not set`);
    }
    if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
      problems.push(`${name}: readOnlyHint and destructiveHint are both true`);
    }
    if (
      looksMutating(name) &&
      annotations.destructiveHint !== true &&
      !allowed.has(name)
    ) {
      problems.push(`${name}: name looks like a mutation but destructiveHint is not true`);
    }
  }
  return problems;
};

/** Throws with every problem from {@link auditToolAnnotations}. For test suites. */
export const assertToolAnnotations = (
  tools: ReadonlyMap<string, ToolAnnotations | undefined>,
  options: AnnotationAuditOptions = {},
): void => {
  const problems = auditToolAnnotations(tools, options);
  if (problems.length > 0) {
    throw new Error(`Tool annotation problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
};

const HINT_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

// An input schema can have a field named like a hint (a zod shape with `readOnlyHint`),
// but its value is a schema object. Only an own, boolean-valued hint marks the annotations.
const looksLikeAnnotations = (value: unknown): value is ToolAnnotations =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  HINT_KEYS.some(
    (key) => Object.hasOwn(value, key) && typeof (value as Record<string, unknown>)[key] === "boolean",
  );

/**
 * Fake MCP server that records each tool's annotations, for tests. Supports
 * `server.tool(name, description?, schema?, annotations?, handler)` (the
 * annotations are the object argument that carries a hint key) and
 * `server.registerTool(name, { annotations })`.
 *
 *     const { server, tools } = recordToolAnnotations();
 *     registerAllTools(server as never, client);
 *     assertToolAnnotations(tools);
 */
export const recordToolAnnotations = (): {
  server: {
    tool: (name: string, ...rest: unknown[]) => void;
    registerTool: (name: string, config?: { annotations?: ToolAnnotations }) => void;
  };
  tools: Map<string, ToolAnnotations | undefined>;
} => {
  const tools = new Map<string, ToolAnnotations | undefined>();
  return {
    tools,
    server: {
      tool: (name, ...rest) => {
        tools.set(name, rest.find(looksLikeAnnotations));
      },
      registerTool: (name, config) => {
        tools.set(name, config?.annotations);
      },
    },
  };
};
