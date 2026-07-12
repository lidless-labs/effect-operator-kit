import { Data } from "effect";

export class ConfigError extends Data.TaggedError("ConfigError")<{
  key?: string;
  message: string;
  value?: string;
  cause?: unknown;
}> {}

export class AuthError extends Data.TaggedError("AuthError")<{
  method: string;
  path: string;
  status: number;
  body?: string;
}> {}

export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  method: string;
  path: string;
  status: number;
  body?: string;
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  method: string;
  path: string;
  status: number;
  body?: string;
}> {}

export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  method: string;
  path: string;
  timeoutMs: number;
}> {}

export class TransportError extends Data.TaggedError("TransportError")<{
  method: string;
  path: string;
  cause: unknown;
}> {}

export class ParseError extends Data.TaggedError("ParseError")<{
  path?: string;
  body?: string;
  message: string;
  cause?: unknown;
}> {}

export class UnexpectedStatusError extends Data.TaggedError("UnexpectedStatusError")<{
  method: string;
  path: string;
  status: number;
  body: string;
  expected: readonly number[];
}> {}

export type OperatorError =
  | ConfigError
  | AuthError
  | ForbiddenError
  | NotFoundError
  | TimeoutError
  | TransportError
  | ParseError
  | UnexpectedStatusError;
