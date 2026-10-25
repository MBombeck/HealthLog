/**
 * Call a route handler the way Next.js would, through the real `apiHandler`,
 * against the worker's real database, and check the answer against the
 * published contract.
 *
 * What runs: the exported handler (`GET`, `POST`, …) of a `route.ts`, which
 * every API route wraps in `apiHandler`. Authentication (cookie session or
 * Bearer token, scope checks, the acting-account resolver), the error
 * envelope, Zod validation, idempotency, rate limits and the handler body are
 * all the production code. What does not run is the edge in `src/proxy.ts`
 * (security headers, the public-path allowlist, demo mode), which has its own
 * tests.
 *
 * The contract check: the response status must be one the OpenAPI registry
 * (`src/lib/openapi/routes`) declares for that path and method, and a JSON
 * body must parse with the schema registered for that status. Keys the
 * schema does not declare fail too, because a client generated from the
 * contract cannot see them and a field nobody declared is a field nobody
 * promised to keep. Every kit test is therefore also a consumer contract
 * check for the native client, at no extra cost to whoever writes it. A test
 * that deliberately calls an unregistered route, or reaches a body the
 * registry cannot describe, says so with `contract: { skip: "<reason>" }`.
 */
import { NextRequest } from "next/server";
import type { z } from "zod";

import { openApiComponents, openApiPaths } from "@/lib/openapi/routes";
import { sessionCookieName } from "@/lib/auth/session-cookie";

import { cookieJar, headerJar } from "../integration/mock-next-headers";
import type { BearerFixture, SessionFixture } from "./factories";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteAuth = SessionFixture | BearerFixture | { kind: "anonymous" };

export const anonymous: RouteAuth = { kind: "anonymous" };

type RouteParams = Record<string, string | string[]>;

/**
 * The shape Next.js hands a route handler. Written as a method so a handler
 * whose context names its own params (`{ params: Promise<{ id: string }> }`)
 * is accepted without a cast; static handlers that take only the request, or
 * nothing at all, fit as they are.
 */
type RouteHandler = {
  handle(
    request: NextRequest,
    context: { params: Promise<RouteParams> },
  ): Promise<Response>;
}["handle"];

export interface CallRouteOptions {
  method: HttpMethod;
  /** The path as the contract names it, e.g. `/api/tokens/{id}`. */
  route: string;
  /** Values for the `{…}` segments of `route`. */
  params?: RouteParams;
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Serialised as JSON with `content-type: application/json`. A `FormData`
   * goes out as a multipart body instead, with the boundary the platform
   * picks.
   */
  body?: unknown;
  /**
   * A raw text body sent as it is (a CSV upload), with
   * `content-type: text/plain` unless `headers` names another. Not combined
   * with `body`.
   */
  text?: string;
  auth: RouteAuth;
  headers?: Record<string, string>;
  contract?: { skip: string };
}

export interface RouteResult<T = unknown> {
  status: number;
  headers: Headers;
  /** The parsed JSON body, or the text of a non-JSON one. */
  body: unknown;
  /** `body.data` of the envelope; typed by the caller, checked by the contract. */
  data: T;
  error: string | null;
  meta: Record<string, unknown> | undefined;
}

export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractViolation";
  }
}

export async function callRoute<T = unknown>(
  handler: RouteHandler,
  options: CallRouteOptions,
): Promise<RouteResult<T>> {
  const path = concretePath(options.route, options.params ?? {});
  const url = new URL(path, "http://localhost:3000");
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  if (options.text !== undefined && options.body !== undefined) {
    throw new Error("callRoute: pass either `body` or `text`, not both");
  }
  const headers = new Headers(options.headers);
  if (options.text !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "text/plain");
  }
  const multipart = options.body instanceof FormData;
  if (
    options.body !== undefined &&
    !multipart &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  if (options.auth.kind === "bearer") {
    headers.set("authorization", `Bearer ${options.auth.token}`);
  }
  if (options.auth.kind === "session") {
    headers.set("cookie", `${sessionCookieName()}=${options.auth.cookie}`);
  }

  // `next/headers` is served from the shared jars; fill them for this call
  // and put them back afterwards, so a record-context assertion a test set
  // with `switchSessionTo` survives and nothing of this call leaks into the
  // next one.
  const savedCookies = new Map(cookieJar);
  const savedHeaders = new Map(headerJar);
  cookieJar.clear();
  if (options.auth.kind === "session") {
    cookieJar.set(sessionCookieName(), options.auth.cookie);
  }
  headerJar.delete("authorization");
  headers.forEach((value, name) => headerJar.set(name.toLowerCase(), value));

  let response: Response;
  try {
    const request = new NextRequest(url, {
      method: options.method,
      headers,
      body:
        options.text !== undefined
          ? options.text
          : options.body === undefined
            ? undefined
            : options.body instanceof FormData
              ? options.body
              : JSON.stringify(options.body),
    });
    response = await handler(request, {
      params: Promise.resolve(options.params ?? {}),
    });
  } finally {
    cookieJar.clear();
    for (const [name, value] of savedCookies) cookieJar.set(name, value);
    headerJar.clear();
    for (const [name, value] of savedHeaders) headerJar.set(name, value);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const isJson = contentType.includes("json") && text.length > 0;
  const body: unknown = isJson ? JSON.parse(text) : text;

  // Not skippable with `contract`: a sealed column leaving the server is a
  // defect whatever the contract says, so no test can opt a route out of it.
  if (isJson) assertNoSealedFields(options.method, options.route, body);

  if (!options.contract?.skip) {
    checkContract(
      options.method,
      options.route,
      response.status,
      contentType,
      body,
      isJson,
    );
  }

  const envelope = isEnvelope(body) ? body : null;
  return {
    status: response.status,
    headers: response.headers,
    body,
    // The one cast in the kit: the contract check above has already parsed
    // the body against the registered schema, and the caller names the type
    // it expects.
    data: (envelope?.data ?? null) as T,
    error:
      envelope && typeof envelope.error === "string" ? envelope.error : null,
    meta:
      envelope && isRecord(envelope.meta)
        ? (envelope.meta as Record<string, unknown>)
        : undefined,
  };
}

/**
 * A column the server stores sealed (`notesEncrypted`, `geometryEncrypted`,
 * every `*Encrypted` field) is decrypted or dropped before a response is
 * built. One that reaches a response anyway arrives as its key or as the
 * serialised bytes (`{"0":…,"1":…}`, or `{ type: "Buffer", data: […] }`).
 * Either fails the call, on every route the kit drives.
 */
export function sealedFieldPaths(value: unknown, at = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => sealedFieldPaths(item, `${at}[${i}]`));
  }
  if (!isRecord(value)) return [];
  const keys = Object.keys(value);
  // A sealed value is at least a nonce and a tag (28 bytes), so a short
  // index-keyed object (an hour map, a weekday tally) is not mistaken for one.
  const bufferShape =
    (value.type === "Buffer" && Array.isArray(value.data)) ||
    (keys.length >= 16 &&
      keys.every((k, i) => k === String(i)) &&
      Object.values(value).every(
        (v) =>
          Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255,
      ));
  if (bufferShape) return [at || "(body)"];
  return keys.flatMap((key) => {
    const path = at ? `${at}.${key}` : key;
    return /encrypted$/i.test(key)
      ? [path]
      : sealedFieldPaths(value[key], path);
  });
}

function assertNoSealedFields(
  method: HttpMethod,
  route: string,
  body: unknown,
): void {
  const found = sealedFieldPaths(body);
  if (found.length > 0) {
    throw new ContractViolation(
      `${method} ${route} sent sealed or raw byte fields to the client: ${found.join(", ")}. Decrypt onto the readable field or drop the column before the response is built.`,
    );
  }
}

function concretePath(route: string, params: RouteParams): string {
  const used = new Set<string>();
  const path = route.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`callRoute: no value for {${name}} in ${route}`);
    }
    used.add(name);
    return Array.isArray(value)
      ? value.map(encodeURIComponent).join("/")
      : encodeURIComponent(value);
  });
  for (const name of Object.keys(params)) {
    if (!used.has(name)) {
      throw new Error(`callRoute: ${route} has no {${name}} segment`);
    }
  }
  return path;
}

interface ResponseObject {
  content?: Record<string, { schema?: unknown }>;
  $ref?: string;
}

function lookupResponse(
  method: HttpMethod,
  route: string,
  status: number,
): ResponseObject {
  const pathItem = (openApiPaths as Record<string, unknown>)[route];
  if (!isRecord(pathItem)) {
    throw new ContractViolation(
      `${method} ${route} is not in the OpenAPI registry. Register the route in src/lib/openapi/routes, or pass contract: { skip: "<reason>" }.`,
    );
  }
  const operation = pathItem[method.toLowerCase()];
  if (!isRecord(operation)) {
    throw new ContractViolation(
      `${route} is registered, but not for ${method}.`,
    );
  }
  const responses = isRecord(operation.responses) ? operation.responses : {};
  const declared = responses[String(status)] ?? responses.default;
  if (!isRecord(declared)) {
    throw new ContractViolation(
      `${method} ${route} answered ${status}, which the contract does not declare (declared: ${Object.keys(responses).join(", ")}).`,
    );
  }
  if (typeof declared.$ref === "string") {
    const name = declared.$ref.split("/").pop() ?? "";
    const resolved = (
      openApiComponents.responses as Record<string, unknown> | undefined
    )?.[name];
    if (!isRecord(resolved)) {
      throw new ContractViolation(
        `unresolvable response reference ${declared.$ref}`,
      );
    }
    return resolved as ResponseObject;
  }
  return declared as ResponseObject;
}

function checkContract(
  method: HttpMethod,
  route: string,
  status: number,
  contentType: string,
  body: unknown,
  isJson: boolean,
): void {
  const declared = lookupResponse(method, route, status);
  const content = declared.content ?? {};
  const mediaTypes = Object.keys(content);
  if (!isJson) {
    if (status === 204 || mediaTypes.length === 0) return;
    const mediaType = contentType.split(";")[0]?.trim() ?? "";
    if (!mediaTypes.some((m) => m === mediaType || m === "*/*")) {
      throw new ContractViolation(
        `${method} ${route} ${status} answered ${mediaType || "no content type"}; the contract declares ${mediaTypes.join(", ")}.`,
      );
    }
    return;
  }
  const mediaType = contentType.split(";")[0]?.trim() ?? "";
  const media = content[mediaType] ?? content["application/json"];
  if (!media) {
    throw new ContractViolation(
      `${method} ${route} ${status} answered JSON; the contract declares ${mediaTypes.join(", ") || "no body"}.`,
    );
  }
  if (!isZodSchema(media.schema)) return;
  const parsed = media.schema.safeParse(body);
  // A file download (a FHIR bundle, an export) is often declared as the
  // string it is served as; check it as that string before calling it a
  // mismatch.
  if (!parsed.success && typeof body !== "string") {
    const asText = media.schema.safeParse(JSON.stringify(body));
    if (asText.success) return;
  }
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ContractViolation(
      `${method} ${route} ${status} does not match its registered schema:\n${issues}`,
    );
  }
  const undeclared = undeclaredKeys(body, parsed.data, "");
  if (undeclared.length > 0) {
    throw new ContractViolation(
      `${method} ${route} ${status} carries keys its registered schema does not declare: ${undeclared.slice(0, 12).join(", ")}`,
    );
  }
}

/**
 * Keys present in what the handler sent and absent from what the schema
 * parsed out of it. A closed `z.object` drops keys it does not declare, a
 * loose object or a record keeps them, so the difference is exactly the set
 * of fields the contract never mentions.
 */
function undeclaredKeys(input: unknown, output: unknown, at: string): string[] {
  if (Array.isArray(input) && Array.isArray(output)) {
    return input.flatMap((item, i) =>
      undeclaredKeys(item, output[i], `${at}[${i}]`),
    );
  }
  if (!isRecord(input) || !isRecord(output)) return [];
  const found: string[] = [];
  for (const key of Object.keys(input)) {
    const path = at ? `${at}.${key}` : key;
    if (!(key in output)) {
      found.push(path);
      continue;
    }
    found.push(...undeclaredKeys(input[key], output[key], path));
  }
  return found;
}

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    isRecord(value) &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvelope(
  value: unknown,
): value is { data?: unknown; error?: unknown; meta?: unknown } {
  return isRecord(value) && ("data" in value || "error" in value);
}
