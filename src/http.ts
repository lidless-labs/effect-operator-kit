import { Effect } from "effect";
import {
  AuthError,
  ForbiddenError,
  NotFoundError,
  TimeoutError,
  TransportError,
  ParseError,
  UnexpectedStatusError,
  type OperatorError,
} from "./errors.js";
import { defaultRedact } from "./redaction.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type QueryValue = string | number | boolean | null | undefined;
export type BodyEncoding = "json" | "text" | "form" | "none";

export interface AuthStrategy {
  apply(headers: Headers): Effect.Effect<Headers, never>;
}

export interface HttpContext {
  baseUrl: URL;
  auth?: AuthStrategy;
  defaultHeaders?: HeadersInit;
  timeoutMs: number;
  fetch?: typeof fetch;
  redact?: (value: string) => string;
}

export interface HttpRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue | readonly QueryValue[]>;
  headers?: HeadersInit;
  body?: unknown;
  bodyEncoding?: BodyEncoding;
  responseType?: "json" | "text" | "none";
  timeoutMs?: number;
  expectedStatuses?: readonly number[];
  statusMapper?: (input: {
    status: number;
    method: string;
    path: string;
    bodyText: string;
    expectedStatuses: readonly number[];
  }) => OperatorError | null;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  bodyText: string;
  body: T;
}

const DEFAULT_SUCCESS_STATUSES = Array.from({ length: 100 }, (_, i) => 200 + i);

function redactBody(text: string, redact?: (value: string) => string): string {
  return (redact ?? defaultRedact)(text);
}

function mergeHeaders(...sources: (HeadersInit | undefined)[]): Headers {
  const merged = new Headers();
  for (const source of sources) {
    if (!source) continue;
    const headers = new Headers(source);
    headers.forEach((value, key) => merged.set(key, value));
  }
  return merged;
}

function resolveExpectedStatuses(req: HttpRequest): readonly number[] {
  return req.expectedStatuses ?? DEFAULT_SUCCESS_STATUSES;
}

function isExpectedStatus(status: number, expected: readonly number[]): boolean {
  return expected.includes(status);
}

function resolveBodyEncoding(req: HttpRequest): BodyEncoding {
  if (req.bodyEncoding !== undefined) return req.bodyEncoding;
  return req.body !== undefined ? "json" : "none";
}

function setContentTypeIfAbsent(headers: Headers, contentType: string): void {
  if (!headers.has("content-type")) {
    headers.set("content-type", contentType);
  }
}

function buildRequestBody(
  req: HttpRequest,
  headers: Headers,
): BodyInit | undefined {
  const encoding = resolveBodyEncoding(req);
  switch (encoding) {
    case "none":
      return undefined;
    case "json":
      setContentTypeIfAbsent(headers, "application/json");
      return JSON.stringify(req.body);
    case "text":
      setContentTypeIfAbsent(headers, "text/plain");
      return String(req.body);
    case "form": {
      setContentTypeIfAbsent(
        headers,
        "application/x-www-form-urlencoded",
      );
      const params = new URLSearchParams();
      if (req.body && typeof req.body === "object") {
        for (const [key, value] of Object.entries(
          req.body as Record<string, string>,
        )) {
          params.set(key, String(value));
        }
      }
      return params.toString();
    }
  }
}

function mapUnexpectedStatus(
  req: HttpRequest,
  status: number,
  bodyText: string,
  expectedStatuses: readonly number[],
  redact?: (value: string) => string,
): OperatorError {
  const redacted = redactBody(bodyText, redact);
  const mapperInput = {
    status,
    method: req.method,
    path: req.path,
    bodyText: redacted,
    expectedStatuses,
  };

  if (req.statusMapper) {
    const custom = req.statusMapper(mapperInput);
    if (custom !== null) return custom;
  }

  const base = {
    method: req.method,
    path: req.path,
    status,
    body: redacted,
  };

  switch (status) {
    case 401:
      return new AuthError(base);
    case 403:
      return new ForbiddenError(base);
    case 404:
      return new NotFoundError(base);
    default:
      return new UnexpectedStatusError({
        method: req.method,
        path: req.path,
        status,
        body: redacted,
        expected: expectedStatuses,
      });
  }
}

function parseResponseBody<T>(
  req: HttpRequest,
  bodyText: string,
  redact?: (value: string) => string,
): Effect.Effect<T, ParseError> {
  const responseType = req.responseType ?? "json";

  if (responseType === "none") {
    return Effect.succeed(undefined as T);
  }

  if (responseType === "text") {
    return Effect.succeed(bodyText as T);
  }

  if (bodyText.length === 0) {
    return Effect.succeed(undefined as T);
  }

  return Effect.try({
    try: () => JSON.parse(bodyText) as T,
    catch: (cause) =>
      new ParseError({
        path: req.path,
        body: redactBody(bodyText, redact),
        message: "Failed to parse JSON response",
        cause,
      }),
  });
}

function fetchWithTimeout(
  ctx: HttpContext,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  method: string,
  path: string,
): Effect.Effect<Response, TimeoutError | TransportError> {
  const fetchImpl = ctx.fetch ?? globalThis.fetch;

  return Effect.async<Response, TimeoutError | TransportError>((resume) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const finish = (effect: Effect.Effect<Response, TimeoutError | TransportError>) => {
      clearTimeout(timeoutId);
      resume(effect);
    };

    void fetchImpl(url, { ...init, signal: controller.signal })
      .then((response) => finish(Effect.succeed(response)))
      .catch((cause) => {
        if (cause instanceof Error && cause.name === "AbortError") {
          finish(
            Effect.fail(new TimeoutError({ method, path, timeoutMs })),
          );
          return;
        }
        finish(
          Effect.fail(new TransportError({ method, path, cause })),
        );
      });
  });
}

export const buildUrl = (
  baseUrl: URL,
  path: string,
  query?: HttpRequest["query"],
): URL => {
  const url = new URL(path, baseUrl);

  if (url.origin !== baseUrl.origin) {
    throw new TypeError(
      `buildUrl: path "${path}" resolves to a different origin (${url.origin}) than baseUrl (${baseUrl.origin})`,
    );
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === null || item === undefined) continue;
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url;
};

function buildHeaders(
  ctx: HttpContext,
  req: HttpRequest,
): Effect.Effect<Headers, never> {
  const auth = ctx.auth;
  if (!auth) {
    return Effect.succeed(mergeHeaders(ctx.defaultHeaders, req.headers));
  }

  return Effect.gen(function* () {
    let headers = mergeHeaders(ctx.defaultHeaders);
    headers = yield* auth.apply(headers);
    return mergeHeaders(headers, req.headers);
  });
}

export const sendRequest = <T = unknown>(
  ctx: HttpContext,
  req: HttpRequest,
): Effect.Effect<HttpResponse<T>, OperatorError> => {
  const url = buildUrl(ctx.baseUrl, req.path, req.query);
  const timeoutMs = req.timeoutMs ?? ctx.timeoutMs;
  const expectedStatuses = resolveExpectedStatuses(req);

  return buildHeaders(ctx, req).pipe(
    Effect.flatMap((headers) => {
      const body = buildRequestBody(req, headers);
      const init: RequestInit = {
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
      };

      return fetchWithTimeout(
        ctx,
        url,
        init,
        timeoutMs,
        req.method,
        req.path,
      ).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: () => response.text(),
            catch: (cause) =>
              new TransportError({
                method: req.method,
                path: req.path,
                cause,
              }),
          }).pipe(
            Effect.flatMap((bodyText) => {
              if (!isExpectedStatus(response.status, expectedStatuses)) {
                return Effect.fail(
                  mapUnexpectedStatus(
                    req,
                    response.status,
                    bodyText,
                    expectedStatuses,
                    ctx.redact,
                  ),
                );
              }

              return parseResponseBody<T>(req, bodyText, ctx.redact).pipe(
                Effect.map((parsedBody) => ({
                  status: response.status,
                  headers: response.headers,
                  bodyText,
                  body: parsedBody,
                })),
              );
            }),
          ),
        ),
      );
    }),
  );
};
