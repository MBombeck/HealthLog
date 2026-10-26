/**
 * Read a JSON request body and validate it against a Zod schema, in one call.
 *
 * Every body-accepting route did the same four steps by hand: `safeJson`
 * (415 on a wrong content type, 413 over the size cap, 400 on malformed
 * JSON), return its error, `schema.safeParse(body)`, and on failure answer
 * the multi-issue 422 envelope (`returnAllZodIssues`), often after stamping
 * a validation-failed action on the wide event. This is those steps, with
 * the variations the routes actually use named as options, so a route reads
 * as what it accepts and how it refuses rather than as the plumbing.
 *
 * ```ts
 * const parsed = await parseJsonBody(request, createThingSchema, {
 *   maxBytes: 16 * 1024,
 *   action: "thing.validation-failed",
 *   countIssues: true,
 *   errorCode: "thing.invalid",
 * });
 * if (!parsed.ok) return parsed.error;
 * const input = parsed.data;
 * ```
 *
 * The refusals are the existing helpers' bytes: `safeJson`'s 415/413/400,
 * `returnAllZodIssues` for the 422 (or `apiValidationError` when the route
 * names its own top-level `message`). `src/__tests__/route-body-parse-ratchet.test.ts`
 * counts the routes that still call `safeJson` themselves; the count may
 * only fall.
 */
import type { NextResponse } from "next/server";
import type { z, ZodError } from "zod/v4";

import {
  apiValidationError,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

type ErrorMeta = NonNullable<Parameters<typeof returnAllZodIssues>[2]>;

export interface ParseJsonBodyOptions {
  /** Size cap in bytes; a larger body is refused 413 before parsing. */
  maxBytes?: number;
  /**
   * What the schema is given, from the decoded body. Defaults to the body
   * itself; a route that validates `body ?? {}`, or merges a path parameter
   * in, says so here.
   */
  input?: (body: unknown) => unknown;
  /** Wide-event action stamped on a validation refusal. */
  action?: string;
  /**
   * Put `issue_count` (the number of Zod issues) on the refusal's wide-event
   * meta. Needs `action`.
   */
  countIssues?: boolean;
  /** Further wide-event meta on the refusal, after `issue_count`. Needs `action`. */
  meta?: Record<string, unknown>;
  /** `meta.errorCode` on the 422 envelope. */
  errorCode?: string;
  /**
   * The envelope's top-level `error` sentence. Unset, it is
   * `returnAllZodIssues`'s "Validation failed".
   */
  message?: string;
  /** The refusal's status. Defaults to 422. */
  status?: number;
  /**
   * Runs on a validation refusal, after the wide-event action and before the
   * envelope is built: an audit row, a breadcrumb the options above cannot
   * express. Receives the Zod error and the decoded body.
   */
  onInvalid?: (error: ZodError, body: unknown) => void | Promise<void>;
}

export type ParsedJsonBody<T> =
  | {
      ok: true;
      /** The schema's output. */
      data: T;
      /** The decoded body as the client sent it, before validation. */
      body: unknown;
    }
  | { ok: false; error: NextResponse | Response };

export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  options: ParseJsonBodyOptions = {},
): Promise<ParsedJsonBody<z.output<S>>> {
  const json = await safeJson(
    request,
    options.maxBytes === undefined ? undefined : { maxBytes: options.maxBytes },
  );
  if (json.error) return { ok: false, error: json.error };
  const body: unknown = json.data;

  const parsed = schema.safeParse(options.input ? options.input(body) : body);
  if (parsed.success) return { ok: true, data: parsed.data, body };

  if (options.action) {
    const meta = {
      ...(options.countIssues
        ? { issue_count: parsed.error.issues.length }
        : {}),
      ...options.meta,
    };
    annotate(
      Object.keys(meta).length > 0
        ? { action: { name: options.action }, meta }
        : { action: { name: options.action } },
    );
  }
  if (options.onInvalid) await options.onInvalid(parsed.error, body);

  const status = options.status ?? 422;
  const meta: ErrorMeta | undefined = options.errorCode
    ? { errorCode: options.errorCode }
    : undefined;
  const error =
    options.message === undefined
      ? returnAllZodIssues(parsed.error, status, meta)
      : apiValidationError(
          options.message,
          sanitiseZodIssues(parsed.error.issues),
          status,
          meta,
        );
  return { ok: false, error };
}
