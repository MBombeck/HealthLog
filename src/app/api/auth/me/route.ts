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
 * modules, their identity — and the one field about the switch,
 * `accountAccess`, says so explicitly. Nothing here ever renders the owner's
 * data; a delegate reading their own display preferences while inside
 * somebody else's record is the correct behaviour and the reason the mode
 * exists (design §4: locale, theme and layout belong to the person, not the
 * record).
 */
import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireActorAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { setOnboardingPendingCookie } from "@/lib/auth/session";
import { syncMfaEnrollCookie } from "@/lib/auth/mfa-enrollment";
import { buildAvatarUrl } from "@/lib/avatar";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { isCycleEnabled } from "@/lib/cycle/gate";
import {
  resolveModuleMap,
  getOperatorModuleAvailability,
} from "@/lib/modules/gate";
import { parseTourProgress } from "@/lib/onboarding/tour-progress";
import { parseNotificationPrefs } from "@/lib/validations/notification-prefs";
import { resolveAccountAccess } from "@/lib/sharing/account-access";
import { recordSessionForPayload } from "@/lib/sharing/record-session-fence";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const auth = await requireActorAuth();
  const { user } = auth;

  annotate({ action: { name: "auth.me" } });

  // Two independent awaits, overlapped: the onboarding-cookie resync
  // (v1.4.22 W5 Sr-H1 — fall-back for legacy sessions that predate the
  // cookie; new sessions anchor it inside `createSession`) touches only
  // the cookie store, while the cycle-profile read (v1.15.0 — resolved
  // cycle-tracking gate; no row is forced, a NULL toggle derives from
  // gender) is a Postgres round-trip. Running them sequentially added
  // the cookie hop to every /me — and /me sits on every app boot path.
  const [, , cycleProfile, modules, moduleAvailability, accountAccess] =
    await Promise.all([
      setOnboardingPendingCookie(user.onboardingCompletedAt == null),
      // v1.23 — keep the admin-enforced-MFA hint cookie honest on every app
      // boot, mirroring the onboarding-cookie resync. A locally edited cookie is
      // corrected here; an account that enrols (or has the policy lifted) loses
      // the redirect on the next /me read.
      syncMfaEnrollCookie(user.id, {
        totpConfirmedAt: user.totpConfirmedAt,
        mfaEnforced: user.mfaEnforced,
      }),
      prisma.cycleProfile.findUnique({
        where: { userId: user.id },
        select: { cycleTrackingEnabled: true },
      }),
      // v1.18.0 — resolved module enable/disable map for every toggleable
      // module. cycle/coach reflect their real delegated state (the cycle
      // gate / disableCoach + operator assistant flag); the rest read the
      // disabled-allowlist `modulePreferencesJson`. Default-on. Clients
      // hide a whole module surface end-to-end when its key is `false`.
      resolveModuleMap(user.id),
      // v1.18.0 — operator-layer availability map (server-wide kill-switch).
      // The resolved `modules` map above already AND-s this in, so it cannot
      // distinguish operator-off from user-off. The Modules hub needs that
      // distinction to render an operator-disabled module as a read-only
      // "disabled server-wide" row instead of a live toggle that no-ops.
      getOperatorModuleAvailability(),
      // v1.36.0 — which records this caller may open, which one they are
      // inside, and what they may do there. Every value resolved server-side;
      // see the module docblock for why none of it is left to the client.
      resolveAccountAccess(auth),
    ]);
  const cycleTrackingEnabled = isCycleEnabled(user.gender, cycleProfile);

  // v1.7.0 — patient-identity fields for the health-record export. The
  // KVNR is stored encrypted; decrypt fail-soft so a key-rotation gap on
  // one row never 500s the whole profile fetch (the field just reads
  // null and the user re-enters it).
  let insuranceNumber: string | null = null;
  if (user.insuranceNumberEncrypted) {
    try {
      insuranceNumber = decrypt(user.insuranceNumberEncrypted);
    } catch {
      insuranceNumber = null;
    }
  }

  return apiSuccess({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role ?? "USER",
    heightCm: user.heightCm,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender,
    timezone: user.timezone,
    onboardingCompletedAt: user.onboardingCompletedAt,
    onboardingTourCompleted: user.onboardingTourCompleted,
    // v1.18.6 (DISC-02) — one-time medical-disclaimer acknowledgment. Null
    // when never acknowledged; the onboarding welcome gate reads this to
    // decide whether to require the acknowledgment before "Get started".
    disclaimerAcknowledgedAt: user.disclaimerAcknowledgedAt,
    // The version that acknowledgment was given for. The welcome gate
    // compares it against the current DISCLAIMER_VERSION so a revised
    // disclaimer re-prompts instead of riding an old acknowledgment.
    disclaimerAcknowledgedVersion: user.disclaimerAcknowledgedVersion,
    // v1.18.6 — resumable module-tour progress. Null when the user has
    // not started the tour; otherwise the resume point the launcher
    // seeds its index from. Fail-soft parse: a corrupt blob degrades to
    // null ("start from the top") rather than 500-ing the /me read.
    onboardingTourProgress: parseTourProgress(user.onboardingTourProgressJson),
    // v1.5.5 — self-hosted avatar. Replaces the Gravatar leak; the
    // URL is relative so PWA + native clients render identically
    // and the `?v={updatedAtMs}` suffix busts the browser cache on
    // a re-upload. Null when the user has not uploaded an avatar
    // yet; clients paint the username-initials fallback.
    avatarUrl: user.avatarUpdatedAt
      ? buildAvatarUrl(user.id, user.avatarUpdatedAt)
      : null,
    glucoseUnit: user.glucoseUnit ?? null,
    // v1.7.0 — global metric/imperial display preference. Canonical
    // storage stays SI; this only drives the display-time transform
    // branch. Null defaults to "metric" on the client.
    unitPreference: user.unitPreference === "imperial" ? "imperial" : "metric",
    // Hour-cycle display preference (AUTO follows the locale convention,
    // H12 / H24 pin the cycle). Clients mirror this into their formatters.
    timeFormat: user.timeFormat ?? "AUTO",
    // Date-order display preference (AUTO follows the locale convention,
    // DMY / MDY / YMD pin the field order). Clients mirror this into their
    // formatters and the <DateField> primitive.
    dateFormat: user.dateFormat ?? "AUTO",
    lastReportPracticeName: user.lastReportPracticeName ?? null,
    // The owner's saved report selection — the leaf inclusion list plus the
    // format / range / charts choices the export panel restores. `null` when
    // the account has never saved one, which is what makes the panel show the
    // named template on the first run rather than a silent server default.
    reportSelection: user.reportSelectionJson ?? null,
    // The account's resolved notification preferences — the same resolver
    // `GET /api/auth/me/notification-prefs` answers with, so the two surfaces
    // cannot disagree. Published here because the medication detail's
    // notification section decides between the server-side reminder switch and
    // the client-managed chip on `medication.clientManaged`, and it reads that
    // decision off THIS payload: the dedicated endpoint is not on the app-boot
    // path. An account that has never opted in resolves to the documented
    // defaults rather than to `undefined`, so the switch is what renders.
    // No extra query — the session already loads the row this column is on.
    notificationPrefs: parseNotificationPrefs(user.notificationPrefs ?? null),
    // v1.4.47 W3 — per-user Coach opt-out. Default `false` if the
    // column is absent (partial-deploy rollback safety, see migration
    // 0078 commentary). Every Coach mount point on the client checks
    // `user.disableCoach` BELOW the operator-level `flags.coach`
    // short-circuit; both gates must agree to paint the affordance.
    disableCoach: user.disableCoach ?? false,
    // v1.7.0 — health-record export identity fields. All optional.
    fullName: user.fullName ?? null,
    insurerName: user.insurerName ?? null,
    insurerIkNumber: user.insurerIkNumber ?? null,
    insuranceNumber,
    // v1.15.0 — cycle-tracking feature gate, resolved server-side. iOS
    // hides the whole cycle tab when this is false.
    cycleTrackingEnabled,
    // v1.18.0 — module enable/disable map. `{ <moduleKey>: boolean }`
    // for every toggleable module; `false` means the module is OFF and
    // the surface should disappear end-to-end (nav, dashboard, insights,
    // …). `cycle` mirrors `cycleTrackingEnabled` and `coach` mirrors the
    // resolved `disableCoach` + operator master flag, so this map is the
    // single thing a client needs to gate every secondary domain.
    modules,
    // v1.18.0 — operator-layer availability per toggleable module. `false`
    // ⇒ the operator turned the module off server-wide (off for every
    // account regardless of personal preference). The Modules hub reads
    // this to show a "disabled server-wide" read-only row; everywhere else
    // the already-AND-ed `modules` map is the single gate to read.
    moduleAvailability,
    // v1.36.0 — account sharing, resolved. `accounts` is the switcher's menu,
    // `active` is the record this session is inside (null when it is in its
    // own), `canSwitch` and per-entry `canWrite` are the booleans the UI binds
    // directly. Always present — an account with no grants gets an empty list,
    // not a missing field.
    accountAccess,
    // v1.37.0 — the record-session fence's bootstrap, and the only place a
    // browser can learn its context from scratch.
    //
    // `epoch` is the session row's selector counter; `scope` is the account the
    // session is pointed at, or null for its own record. The client adopts both
    // and attaches them to every subsequent same-origin request, so the server
    // can refuse a request formed under a context that has since moved. This
    // response and `POST /api/account/switch` are the only two a client may
    // ADOPT from — every other response carries the context in headers, and
    // those are used to validate a response, never to learn one.
    //
    // Null on the Bearer transport, which has no session row and no switch
    // state to be stale about. A native client neither sends nor receives the
    // fence headers; the frozen contract is untouched.
    // Derived by the fence rather than read off the context here: the columns
    // behind it have one reader by design, and a route that projected them
    // itself would be a second statement of what a record context is.
    recordSession: recordSessionForPayload(auth),
  });
});
