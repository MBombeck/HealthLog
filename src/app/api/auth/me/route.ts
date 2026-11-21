/**
 * `GET /api/auth/me` — the account payload, and the one surface that keeps
 * answering while the browser is acting on somebody else's record.
 *
 * v1.36.0 made it an ACTOR surface (`requireActorAuth`). It has to be: the
 * switcher, the banner naming whose record is open, and the way back out all
 * read this payload, and all three are about the person at the keyboard, not
 * the record they are looking at. Under a bare `requireAuth()` the whole app
 * shell would 403 the moment a switch was on.
 *
 * So every field below is still the CALLER's own — their preferences, their
 * identity — and the one field about the switch, `accountAccess`, says so
 * explicitly. Nothing here ever renders the owner's health data; a delegate
 * reading their own display preferences while inside somebody else's record is
 * the correct behaviour and the reason the mode exists (design §4: locale,
 * theme and layout belong to the person, not the record).
 *
 * TWO fields are the exception, and the exception is the rule applied rather
 * than a hole in it: `modules` and `cycleTrackingEnabled` resolve for the
 * RECORD the session is inside, not for the actor (#939). They are not display
 * preferences. They say what this record tracks — and every consumer of them
 * gates a surface that shows the RECORD's data: the navigation, the dashboard
 * tiles, the insights sections, quick-add. Publishing the actor's map while
 * switched meant a Guardian who turned Cycle off for the child still saw a
 * Cycle destination in the child's record, and a Guardian who tracks it saw
 * one there whether or not the child did — the toggle in the record's own
 * settings wrote a column nothing on screen was reading. Design §4 is about
 * whose eyes are on the screen; this is about whose record is on it.
 *
 * Those two fields are then MASKED to the sections the active grant names.
 * `accountAccess.active` is set for any live grant, level and scope included,
 * so the record scoping on its own would hand a delegate scoped to
 * `measurements` the owner's cycle, screener, illness and nutrient
 * configuration — and the cycle flag is a derivation of the owner's recorded
 * sex. A section the grant does not open answers `false`, which is the answer
 * a module that is off already gives and the answer the browser's own route
 * inventory has always acted on. An unscoped grant names every section and is
 * unaffected.
 *
 * The own-record case is byte-identical: with no switch the active record IS
 * the caller, there is no grant to narrow to, and every value below is
 * resolved from the same row it always was.
 */
import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireActorAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { setOnboardingPendingCookie } from "@/lib/auth/session";
import { syncMfaEnrollCookie } from "@/lib/auth/mfa-enrollment";
import { buildAuthMePayload } from "@/lib/auth/me-payload";
import { resolveAccountAccess } from "@/lib/sharing/account-access";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const auth = await requireActorAuth();
  const { user } = auth;

  annotate({ action: { name: "auth.me" } });

  // Overlapped, not sequential: the two cookie resyncs (v1.4.22 W5 Sr-H1 —
  // the onboarding fall-back for sessions that predate the cookie; new ones
  // anchor it inside `createSession`) touch only the cookie store, while the
  // access resolution is a Postgres round-trip. Running them one after the
  // other added the cookie hop to every /me, and /me sits on every app boot.
  const [, , accountAccess] = await Promise.all([
    setOnboardingPendingCookie(user.onboardingCompletedAt == null),
    // v1.23 — keep the admin-enforced-MFA hint cookie honest on every app
    // boot, mirroring the onboarding-cookie resync. A locally edited cookie is
    // corrected here; an account that enrols (or has the policy lifted) loses
    // the redirect on the next /me read.
    syncMfaEnrollCookie(user.id, {
      totpConfirmedAt: user.totpConfirmedAt,
      mfaEnforced: user.mfaEnforced,
    }),
    // v1.36.0 — which records this caller may open, which one they are
    // inside, and what they may do there. Every value resolved server-side;
    // see the module docblock for why none of it is left to the client.
    resolveAccountAccess(auth),
  ]);

  // The payload itself is built by the one builder the root layout's server
  // render shares (`src/lib/auth/me-payload.ts`).
  return apiSuccess(await buildAuthMePayload(auth, accountAccess));
});
