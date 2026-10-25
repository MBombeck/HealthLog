/**
 * GET /api/auth/native/complete
 *
 * Completion leg of the first-party web-handoff login (iOS #65). After the user
 * signs in on the instance's own web login page (inside the app's
 * `ASWebAuthenticationSession`), the page navigates the browser here as a
 * top-level GET. This endpoint validates the web session, enforces the FRESHNESS
 * BINDING, mints a single-use handoff code, and redirects to the compiled-in
 * custom scheme carrying ONLY the opaque code.
 *
 * Security-critical invariants:
 * - `userId` is resolved SOLELY from the DB-validated session cookie — the
 *   request carries no identity field; the app challenge lives in the
 *   tamper-authenticated state cookie.
 * - FRESHNESS: `session.createdAt >= state.startedAt`. The session completing the
 *   flow must have been minted AFTER the flow started — i.e. the user actually
 *   authenticated inside this ASWebAuthenticationSession. A pre-existing browser
 *   session can NEVER silently complete a handoff. Both timestamps are DB-clock
 *   values, so there is no app/DB skew (red-team A1). `createdAt` is read from a
 *   dedicated projection (`validateSessionWithCreatedAt`) so the comparison can
 *   never be silently dropped (red-team A3).
 * - The token pair NEVER rides the URL — only the opaque code does.
 * - Every failure redirects to `healthlog://login-callback?error=<reason>` and
 *   deletes the state cookie; no code or row is minted on any failure branch.
 */
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { validateSessionWithCreatedAt } from "@/lib/auth/session";
import {
  expireSessionCookies,
  readSessionCookie,
} from "@/lib/auth/session-cookie";
import { mintNativeHandoff } from "@/lib/auth/native-handoff";
import {
  NATIVE_HANDOFF_STATE_COOKIE,
  NATIVE_HANDOFF_STATE_COOKIE_PATH,
  buildWebHandoffCallbackUrl,
  decodeNativeHandoffState,
  type NativeHandoffErrorReason,
} from "@/lib/auth/native-web-handoff";

export const dynamic = "force-dynamic";

/**
 * The state cookie is path-scoped to `/api/auth/native`; RFC 6265 keys cookies
 * by name+domain+path, so the delete must repeat that path or it silently
 * targets `/` and leaves the single-use blob alive.
 */
function deleteStateCookie(response: NextResponse): void {
  response.cookies.delete({
    name: NATIVE_HANDOFF_STATE_COOKIE,
    path: NATIVE_HANDOFF_STATE_COOKIE_PATH,
  });
}

export const GET = apiHandler(async (req: NextRequest) => {
  annotate({ action: { name: "auth.native.complete" } });

  // Every failure — and success — deletes the single-use state cookie.
  const fail = (reason: NativeHandoffErrorReason): NextResponse => {
    const response = NextResponse.redirect(
      buildWebHandoffCallbackUrl({ error: reason }),
    );
    deleteStateCookie(response);
    return response;
  };

  const rl = await checkAuthSurfaceRateLimit(
    req,
    "auth:native:complete",
    20,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) {
    annotate({ meta: { reason: "rate_limited" } });
    return fail("rate_limited");
  }

  // (1) The encrypted, tamper-authenticated state cookie. A missing, forged, or
  // tampered blob (AES-256-GCM auth tag) fails to decode → no mint.
  const state = decodeNativeHandoffState(
    req.cookies.get(NATIVE_HANDOFF_STATE_COOKIE)?.value,
  );
  if (!state) {
    annotate({ meta: { reason: "invalid_state" } });
    return fail("invalid_state");
  }

  // (2) A genuinely authenticated web session — validated against the database
  // (row + expiry), never "a cookie is present". Projects `createdAt` so the
  // freshness comparison below is structurally always available.
  const authed = await validateSessionWithCreatedAt(
    readSessionCookie(req.cookies)?.value,
  );
  if (!authed) {
    annotate({ meta: { reason: "no_session" } });
    return fail("no_session");
  }

  // (3) FRESHNESS BINDING. The session must have been minted AFTER the flow
  // started. A stale (pre-existing) session is refused and mints NOTHING.
  const startedAt = new Date(state.startedAt);
  if (authed.session.createdAt.getTime() < startedAt.getTime()) {
    annotate({ meta: { reason: "stale_session" } });
    return fail("stale_session");
  }

  // (4) Mint the single-use, PKCE-locked, flow-tagged handoff code. `userId` is
  // the server-resolved session identity; the app's S256 challenge (from the
  // tamper-authenticated cookie) locks the code to the app instance that
  // started the flow.
  const ua = req.headers.get("user-agent");
  const { code } = await mintNativeHandoff({
    userId: authed.user.id,
    appCodeChallenge: state.appCodeChallenge,
    flow: "web_login",
    ipAddress: ip,
    userAgent: ua,
  });

  await auditLog("auth.native.handoff_minted", {
    userId: authed.user.id,
    ipAddress: ip,
  });
  annotate({ action: { name: "auth.native.handoff_minted" } });

  const response = NextResponse.redirect(buildWebHandoffCallbackUrl({ code }));
  deleteStateCookie(response);

  // (5) Destroy the scaffold web session (design §2.6, recommended). The flow's
  // product is the native bundle; the browser sheet's residual login is not
  // something the user asked for, and the freshness rule already makes a
  // retained session worthless for any FUTURE flow. Best-effort — a delete
  // hiccup never fails the handoff.
  await prisma.session
    .delete({ where: { id: authed.session.id } })
    .catch(() => {});
  expireSessionCookies(response.cookies);

  return response;
});
