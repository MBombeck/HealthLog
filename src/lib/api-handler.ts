import { NextRequest, NextResponse } from "next/server";
import { WideEventBuilder } from "./logging/event-builder";
import { eventStorage, getEvent } from "./logging/context";
import { emitIfSampled } from "./logging/transports";
import { getSession } from "./auth/session";

/**
 * Custom error class for HTTP errors with status codes.
 * Throw inside apiHandler-wrapped routes to return a JSON error response.
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Wraps an API route handler with Wide Event logging.
 * Creates a WideEventBuilder, runs the handler inside AsyncLocalStorage,
 * catches errors, and emits the event on completion.
 *
 * No CSRF check — HealthLog does not use CSRF tokens.
 * Auth annotation happens in routes via requireAuth().
 */
// Next.js route handlers come in two shapes — `(request)` for static routes
// and `(request, { params })` for dynamic ones. The variadic generic is the
// only signature TS accepts that covers both at the call site. The `any[]`
// here is constrained by the bound (T must return Promise<Response>) so it
// does not loosen handler bodies — only their parameter list.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apiHandler<T extends (...args: any[]) => Promise<Response>>(
  handler: T,
): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = async (...args: any[]): Promise<Response> => {
    const request = args[0] as NextRequest;
    const url = new URL(request.url);

    const evt = new WideEventBuilder("http");

    // Propagate x-request-id if present
    const incomingRequestId = request.headers.get("x-request-id");
    if (incomingRequestId) evt.setRequestId(incomingRequestId);

    evt.setHttp({
      method: request.method,
      path: url.pathname,
      route: url.pathname,
      status: 200,
      user_agent: request.headers.get("user-agent") ?? undefined,
      ip:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        undefined,
    });

    return eventStorage.run(evt, async () => {
      let response: Response | undefined;
      try {
        response = await handler(...args);
      } catch (error) {
        if (error instanceof HttpError) {
          evt.setError(error);
          response = NextResponse.json(
            { data: null, error: error.message },
            { status: error.statusCode },
          );
        } else if (error instanceof SyntaxError) {
          evt.setError(error);
          response = NextResponse.json(
            { data: null, error: "Invalid JSON body" },
            { status: 400 },
          );
        } else {
          evt.setError(error);
          // Report to GlitchTip (fire-and-forget)
          reportToGlitchtip(error, request, evt).catch(() => {});
          response = NextResponse.json(
            { data: null, error: "Interner Serverfehler" },
            { status: 500 },
          );
        }
      } finally {
        const status = (response as Response | undefined)?.status ?? 500;
        evt.finish(status);
        try { emitIfSampled(evt.toJSON()); } catch { /* logging must never crash the handler */ }
      }
      const nr = response as NextResponse;
      nr.headers.set("x-request-id", evt.getRequestId());
      return nr;
    });
  };
  return wrapped as T;
}

/**
 * Require an authenticated session. Throws HttpError(401) if not authenticated.
 * Automatically annotates the Wide Event with auth context.
 */
export async function requireAuth(): Promise<{
  session: { id: string; expiresAt: Date };
  user: Awaited<ReturnType<typeof getSession>> extends infer R
    ? R extends { user: infer U }
      ? U
      : never
    : never;
}> {
  const sessionData = await getSession();
  if (!sessionData) throw new HttpError(401, "Not authenticated");

  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: sessionData.user.id,
      user_role: sessionData.user.role,
      auth_method: "session",
    });
  }

  return sessionData;
}

/**
 * Require an authenticated admin user. Throws HttpError(401) or HttpError(403).
 * Automatically annotates the Wide Event with auth context.
 */
export async function requireAdmin(): Promise<{
  session: { id: string; expiresAt: Date };
  user: Awaited<ReturnType<typeof getSession>> extends infer R
    ? R extends { user: infer U }
      ? U
      : never
    : never;
}> {
  const sessionData = await requireAuth();
  if (sessionData.user.role !== "ADMIN") {
    throw new HttpError(403, "Admin access required");
  }
  return sessionData;
}

/**
 * Report unhandled errors to GlitchTip (fire-and-forget).
 * Uses dynamic import to avoid circular dependencies and startup cost.
 */
async function reportToGlitchtip(
  error: unknown,
  request: NextRequest,
  evt: WideEventBuilder,
): Promise<void> {
  const [{ getGlitchtipSettings }, { sendGlitchtipEvent }] = await Promise.all([
    import("@/lib/monitoring-settings"),
    import("@/lib/monitoring/glitchtip"),
  ]);

  const settings = await getGlitchtipSettings();
  if (!settings.glitchtipEnabled || !settings.glitchtipDsn) return;

  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : "Unknown error");

  // Skip expected errors from bot scanners (malformed JSON bodies)
  if (err instanceof SyntaxError) return;

  await sendGlitchtipEvent({
    dsn: settings.glitchtipDsn,
    input: {
      environment: settings.glitchtipEnvironment || "production",
      message: err.message,
      level: "error",
      type: err.name || "Error",
      stack: err.stack,
      url: request.url,
      sourceTag: "healthlog-api-handler",
      requestId: evt.getRequestId(),
    },
  });
}
