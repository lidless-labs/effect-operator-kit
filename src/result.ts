export interface McpTextResult<T = unknown> {
  content: Array<{ type: "text"; text: string }>;
  details?: T;
  isError?: boolean;
}

export const ok = <T>(details: T): McpTextResult<T> => ({
  content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
  details,
});

export const fail = (message: string, details?: unknown): McpTextResult => {
  const result: McpTextResult = {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message }, null, 2),
      },
    ],
    isError: true,
  };
  if (details !== undefined) {
    result.details = details;
  }
  return result;
};

export const refuseUnconfirmed = (operation: string): McpTextResult =>
  fail(
    `Refusing to ${operation} without explicit confirmation. Re-call this tool with confirm: true to proceed.`,
  );

export const partialFailure = <T>(payload: {
  requested: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped?: number;
  aborted?: boolean;
  results: T[];
}): McpTextResult => ok(payload);
