/**
 * The `GET /api/auth/me` payload, built once for the route and for the root
 * layout's server render.
 *
 * The route answers the app shell's boot read; the layout puts the same
 * payload into the first HTML, so a protected page renders its content
 * instead of a spinner while the browser fetches `/api/auth/me` (the route
 * still runs in the background, and it alone resyncs the two hint cookies).
 * One builder is what keeps the two from ever disagreeing: what the record
 * scoping, the grant masking and the AI resolution decide is decided here.
 *
 * The scoping rules for every field are on the route's docblock
 * (`src/app/api/auth/me/route.ts`).
 */
import type { AuthContext } from "@/lib/api-handler";
import { buildAvatarUrl } from "@/lib/avatar";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { resolveStoredTimezone } from "@/lib/tz/resolver";
import { isCycleEnabled } from "@/lib/cycle/enabled";
import {
  resolveModuleMap,
  getOperatorModuleAvailability,
} from "@/lib/modules/gate";
import {
  emptyOnboardingNeeds,
  readHeldUnitPreferences,
} from "@/lib/onboarding/needs";
import {
  loadOnboardingRecordRow,
  toOnboardingStateDto,
} from "@/lib/onboarding/needs-store";
import { parseTourProgress } from "@/lib/onboarding/tour-progress";
import { parseNotificationPrefs } from "@/lib/validations/notification-prefs";
import { resolveAccountAccess } from "@/lib/sharing/account-access";
import type { AccountAccess } from "@/lib/sharing/account-access-view";
import {
  buildModuleDisclosure,
  sectionsOpen,
} from "@/lib/sharing/module-disclosure";
import { recordSessionForPayload } from "@/lib/sharing/record-session-fence";
import { loadAiCapabilities } from "@/lib/ai/capabilities/load";
import { loadCoachReasoningState } from "@/lib/ai/reasoning/controls";
import { parseCoachPrefs } from "@/lib/validations/coach-prefs";
import { storedGlucoseUnit } from "@/lib/glucose";
import { accountPushState } from "@/lib/push-relay/capability";

/**
 * The push block and the stored zone. Neither needs the record view, so they
 * run beside it rather than after it; the caller awaits the result, and it is
 * never left to reject unobserved if the view throws first.
 */
function pushAndZone(
  userId: string,
  storedZone: string | null,
  request: Request | undefined,
) {
  const read = Promise.all([
    accountPushState(userId, request),
    resolveStoredTimezone(storedZone),
  ]).then(([push, timezone]) => ({ push, timezone }));
  read.catch(() => undefined);
  return read;
}

/**
 * The account payload for one authenticated caller. `accountAccess` may be
 * passed when the caller already resolved it; otherwise it is resolved here.
 */
export async function buildAuthMePayload(
  auth: AuthContext,
  resolvedAccess?: AccountAccess,
  request?: Request,
) {
  const { user } = auth;
  const sidecar = pushAndZone(user.id, user.timezone, request);
  const accountAccess = resolvedAccess ?? (await resolveAccountAccess(auth));
  const {
    onboarding,
    modules,
    moduleAvailability,
    moduleAccess,
    cycleTrackingEnabled,
    ai,
    coachReasoning,
    insuranceNumber,
  } = await loadRecordView(auth, accountAccess);

  const payload = {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    email: user.email,
    role: user.role ?? "USER",
    heightCm: user.heightCm,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender,
    // The zone the server cuts this account's days in: the stored zone, or
    // the instance default when the stored one is unusable. Clients bucket
    // by this value, so it must be the resolved one, not the raw column.
    timezone: (await sidecar).timezone,
    onboardingCompletedAt: user.onboardingCompletedAt,
    onboardingTourCompleted: user.onboardingTourCompleted,
    // The needs-based setup flow, published additively:
    // `steps` (the nine stable ids and their `pending | done | skipped`
    // status), `needs` (the answers as given), `completedAt` (the flow's OWN
    // completion, distinct from `onboardingCompletedAt` above, which keeps its
    // meaning as the first-run redirect's gate) and `firstResult` (the one
    // task the flow offered, and whether it produced its result).
    //
    // Record-scoped, like `modules` and `cycleTrackingEnabled`: it says what
    // the record tracks, and the checklist reads it beside that record's
    // counts. Under a scoped grant the answers are emptied for the reason the
    // module map is masked.
    //
    // Always present, never null: a record that never entered the flow reads
    // as empty answers with nine `pending` steps, so a client branches on the
    // step statuses rather than on the field's existence. A client that meets
    // a step id it does not know skips it — the list is the contract, not the
    // client's own copy of it.
    onboarding,
    // One-time medical-disclaimer acknowledgment. Null
    // when never acknowledged; the onboarding welcome gate reads this to
    // decide whether to require the acknowledgment before "Get started".
    disclaimerAcknowledgedAt: user.disclaimerAcknowledgedAt,
    // The version that acknowledgment was given for. The welcome gate
    // compares it against the current DISCLAIMER_VERSION so a revised
    // disclaimer re-prompts instead of riding an old acknowledgment.
    disclaimerAcknowledgedVersion: user.disclaimerAcknowledgedVersion,
    // Resumable module-tour progress. Null when the user has
    // not started the tour; otherwise the resume point the launcher
    // seeds its index from. Fail-soft parse: a corrupt blob degrades to
    // null ("start from the top") rather than 500-ing the /me read.
    onboardingTourProgress: parseTourProgress(user.onboardingTourProgressJson),
    // Self-hosted avatar. Replaces the Gravatar leak; the
    // URL is relative so PWA + native clients render identically
    // and the `?v={updatedAtMs}` suffix busts the browser cache on
    // a re-upload. Null when the user has not uploaded an avatar
    // yet; clients paint the username-initials fallback.
    avatarUrl: user.avatarUpdatedAt
      ? buildAvatarUrl(user.id, user.avatarUpdatedAt)
      : null,
    // The stored choice, published as the closed pair the contract names.
    glucoseUnit: storedGlucoseUnit(user.glucoseUnit),
    // Global metric/imperial display preference. Canonical
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
    // The caller's own stored Coach opt-out, published for the
    // switch that edits it. Default `false` if the column is absent
    // (partial-deploy rollback safety, see migration 0078 commentary). It is
    // not a gate: whether the Coach shows for the record on screen is the
    // resolved `ai.capabilities.coach` and `modules.coach` below, which fold
    // in the record's own opt-out, the operator's switches and the grant.
    disableCoach: user.disableCoach ?? false,
    // The name the app addresses the account by (dashboard greeting,
    // reports). Set in the setup flow and edited on the profile card, which
    // seeds its field from here.
    displayName: user.displayName ?? null,
    // Health-record export identity fields. All optional.
    fullName: user.fullName ?? null,
    insurerName: user.insurerName ?? null,
    insurerIkNumber: user.insurerIkNumber ?? null,
    insuranceNumber,
    // Cycle-tracking feature gate, resolved server-side. iOS
    // hides the whole cycle tab when this is false. v1.38.14 — resolved for
    // the ACTIVE RECORD, so a switched browser hides the tab the record does
    // not track rather than the one the actor does not (#939), and `false`
    // whenever the active grant does not name the `cycle` section. Unchanged
    // on the native transport, which carries no switch.
    cycleTrackingEnabled,
    // Module enable/disable map. `{ <moduleKey>: boolean }`
    // for every toggleable module; `false` means the module is OFF and
    // the surface should disappear end-to-end (nav, dashboard, insights,
    // …). `cycle` mirrors `cycleTrackingEnabled` and `coach` mirrors the
    // resolved `disableCoach` + operator master flag, so this map is the
    // single thing a client needs to gate every secondary domain.
    // Resolved for the ACTIVE RECORD and masked to the sections
    // the active grant opens; see the module docblock.
    modules,
    // Operator-layer availability per toggleable module. `false`
    // ⇒ the operator turned the module off server-wide (off for every
    // account regardless of personal preference). The Modules hub reads
    // this to show a "disabled server-wide" read-only row; everywhere else
    // the already-AND-ed `modules` map is the single gate to read.
    moduleAvailability,
    // Why each module's surfaces are or are not there, for the record this
    // session is inside: `enabled`, `disabled` (the record's own switch),
    // `not_granted` (the active grant does not open the module's section) or
    // `unavailable` (the operator switched it off for the whole instance).
    // Precedence outside-in: unavailable > not_granted > disabled > enabled.
    // `modules[key]` stays exactly `moduleAccess[key] === "enabled"`, so this
    // adds a reason without moving a gate; empty states read it to say the
    // honest thing rather than offering a switch the reader cannot reach.
    moduleAccess,
    // Which AI capabilities this record has, and why not when it has
    // none: `capabilities` maps every capability key to `{ available, reason,
    // onDeviceAllowed }` (reason is the outermost layer that said no), and
    // `provider` says whether a provider is configured, who manages it, and
    // whether the person in front of the screen may set one up. Resolved for
    // the RECORD and masked to the grant, like `modules`. Clients render from
    // it and never recompute it; data never depends on it.
    ai,
    // The Coach's thinking depth, resolved on the server so the web
    // settings and the native client show the same answer: `level` is what a
    // turn runs at now, `preference` what the person picked, `maxLevel` the
    // highest option the settings may offer (`off` when the operator switched
    // reasoning off), `available` whether reasoning can run at all,
    // `offIsReal` whether the lowest option is a real off or "Minimal", and
    // `source` which layer decided. Clients never recompute it.
    coachReasoning,
    // Account sharing, resolved. `accounts` is the switcher's menu,
    // `active` is the record this session is inside (null when it is in its
    // own), `canSwitch` and per-entry `canWrite` are the booleans the UI binds
    // directly. Always present — an account with no grants gets an empty list,
    // not a missing field.
    accountAccess,
    // The record-session fence's bootstrap, and the only place a
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
    // What this server understands, for a client released on its own
    // schedule (iOS #116, item 18). `trackIntake: true` says medications take
    // the record-only switch, so an add form can offer it before the account
    // has a medication to learn it from. A flag only ever appears here once
    // the server supports it, and stays `true`; absence means an older server.
    features: SERVER_FEATURES,
    // Relay offer, plus the `X-Device-Id` device's state (null when server-rendered).
    push: (await sidecar).push,
  };
  return payload;
}

/**
 * What the payload says about the RECORD the session is inside: its setup
 * state, its modules masked to the grant, its cycle gate and its AI
 * capabilities, plus the caller's decrypted insurance number.
 */
async function loadRecordView(auth: AuthContext, accountAccess: AccountAccess) {
  const { user } = auth;
  // The record the two module fields answer for, and the reason this read is
  // sequenced after the block above rather than inside it: the active record
  // has to be the GRANT-VALIDATED one. The session row's own selector is not
  // that — it is a stamp, and a stamp whose grant was revoked a minute ago
  // still names an account. `resolveAccountAccess` is what checks the live
  // grant, so its answer is what may pick whose configuration is published.
  // The cost is one round-trip on a hot path, paid on every /me; publishing a
  // revoked record's configuration would be paid once, by somebody else.
  const recordId = accountAccess.active?.accountId ?? user.id;

  // What the grant opens, and therefore what the two record fields below may
  // say. `null` is the whole record — the answer for an unscoped grant and for
  // no switch at all, and the reason the own-record payload is untouched.
  const sections = accountAccess.active?.sections ?? null;

  // Who may put a model to work on that record, stated from the switch this
  // payload already resolved rather than read back off the request: this is an
  // actor surface, so the request carries no record authority of its own.
  // One's own record is the owner's; a managed profile is its guardian's,
  // limited to the operator's key; anybody else's is a delegate's, and a
  // delegate starts no AI work on a record that is not theirs.
  const recordKind = accountAccess.active?.recordKind ?? "self";
  const aiAuthority = {
    origin:
      recordKind === "self"
        ? ("owner" as const)
        : recordKind === "managed"
          ? ("guardian" as const)
          : ("delegate" as const),
    recordUserId: recordId,
    actorUserId: user.id,
    grantId: null,
  };

  const [
    record,
    cycleProfile,
    resolvedModules,
    moduleAvailability,
    onboardingRow,
    ai,
    coachReasoning,
    identity,
  ] = await Promise.all([
    // The actor's own row is already in hand; a switched session needs the
    // record's `gender`, which is the column the cycle gate derives from.
    recordId === user.id
      ? Promise.resolve({
          gender: user.gender,
          glucoseUnit: user.glucoseUnit,
          unitPreference: user.unitPreference,
        })
      : prisma.user.findUnique({
          where: { id: recordId },
          select: {
            gender: true,
            // The record's own unit columns, for the setup
            // flow's "never re-ask a value the account holds" rule.
            glucoseUnit: true,
            unitPreference: true,
          },
        }),
    prisma.cycleProfile.findUnique({
      where: { userId: recordId },
      select: { cycleTrackingEnabled: true },
    }),
    // Resolved module enable/disable map for every toggleable
    // module. cycle/coach reflect their real delegated state (the cycle
    // gate / disableCoach + operator assistant flag); the rest read the
    // disabled-allowlist `modulePreferencesJson`. Default-on. Clients
    // hide a whole module surface end-to-end when its key is `false`.
    resolveModuleMap(recordId),
    // Operator-layer availability map (server-wide kill-switch).
    // The resolved `modules` map above already AND-s this in, so it cannot
    // distinguish operator-off from user-off. The Modules hub needs that
    // distinction to render an operator-disabled module as a read-only
    // "disabled server-wide" row instead of a live toggle that no-ops.
    // Server-WIDE, so it is the same map for every record and is not
    // re-scoped here.
    getOperatorModuleAvailability(),
    // The needs-based setup state for the RECORD, like the two
    // module fields above and for the same reason: it says what that record
    // tracks, and its only consumer reads it beside that record's reading
    // count, medication count and integration state. Ordering a record's rows
    // by somebody else's answers is the one thing this field must not do.
    //
    // The three WRITE routes stay actor-only (`requireAuth()` refuses outright
    // under a switch) until a guardian's route into a managed record's setup
    // arrives with the rest of that record's configuration (#939 / C2). A read
    // that is wider than the write is the honest shape here: the storage is
    // keyed by record already, and a delegate seeing the record's own setup
    // state is what makes the dashboard they are looking at coherent.
    loadOnboardingRecordRow(prisma, recordId),
    // The AI capabilities for the RECORD, resolved on the server from
    // every layer that can say no: the operator's switches, the record's
    // modules (masked to the grant exactly like `moduleAccess`), the
    // provider-work authority, provider presence and consent. The module map
    // and the operator availability it needs are the memoised reads above, so
    // the extra cost is the provider presence (two point reads) and one read
    // of the active consent kinds.
    loadAiCapabilities({
      recordId,
      authority: aiAuthority,
      sections,
      recordKind,
    }),
    // The Coach's thinking depth, resolved: the caller's own
    // preference (Coach preferences belong to the person, like every other
    // display preference here) against the operator's switch and cap and the
    // record's provider. The provider read is the memoised presence probe the
    // `ai` block above already ran.
    loadCoachReasoningState({
      prefs: parseCoachPrefs(user.coachPrefsJson),
      recordId,
      authority: aiAuthority,
    }),
    // The encrypted insurance number is not on the per-request user
    // (`SESSION_USER_SELECT`); it is read here, for the one response that
    // shows it.
    prisma.user.findUnique({
      where: { id: user.id },
      select: { insuranceNumberEncrypted: true },
    }),
  ]);

  // The masking step, and the one place the record scoping is narrowed rather
  // than resolved. `active` is set for ANY live grant — a READ grant scoped to
  // `measurements` included — so publishing the record's whole map would tell
  // a delegate whether the owner tracks their cycle, their screeners, their
  // illness episodes or their supplement intake, none of which their grant
  // opens. A closed section reads `false`, the same answer a module that is
  // off already gives, and the navigation the client builds from it drops
  // exactly the doors `isSharedRecordPathPresentable` drops anyway.
  // Two maps out of one pass: `modules` is the boolean gate map, masked
  // exactly as it was, and `moduleAccess` is the same answer with the reason
  // attached — the record's own switch, the grant's edge, or the operator's.
  // Every client that only wants "paint it or not" keeps reading the boolean.
  // The published steps carry the Q6 resolution: a record whose
  // account already holds both unit preferences reads `units` as `done`, so
  // the flow never re-asks a value the account holds.
  const recordOnboarding = toOnboardingStateDto(
    onboardingRow,
    readHeldUnitPreferences({
      glucoseUnit: record?.glucoseUnit ?? null,
      unitPreference: record?.unitPreference ?? null,
    }),
  );
  // The answers name the domains the record tracks, which is exactly what the
  // module map below is masked for. A SCOPED grant therefore gets the shape of
  // the flow — how far it got, what it ended on — with the answers emptied;
  // an unscoped grant, and the record's own session, get them whole.
  const onboarding =
    sections === null
      ? recordOnboarding
      : { ...recordOnboarding, needs: emptyOnboardingNeeds() };

  const { modules, moduleAccess } = buildModuleDisclosure(
    resolvedModules,
    moduleAvailability,
    sections,
  );
  // The cycle flag is masked on its own rather than read off `modules.cycle`:
  // that key also carries the operator's server-wide availability, and this
  // field never has. Same section, same answer, without borrowing a second
  // layer's decision.
  const cycleTrackingEnabled =
    sectionsOpen(sections, "cycle") &&
    isCycleEnabled(record?.gender ?? null, cycleProfile);

  const insuranceNumber = readInsuranceNumber(
    identity?.insuranceNumberEncrypted,
  );

  return {
    onboarding,
    modules,
    moduleAvailability,
    moduleAccess,
    cycleTrackingEnabled,
    ai,
    coachReasoning,
    insuranceNumber,
  };
}

/**
 * Capability flags for clients that are not shipped with the server. Constant
 * by design: a feature the server supports is supported for every account,
 * and a per-account answer belongs in `modules` or `ai`, not here.
 */
const SERVER_FEATURES = {
  trackIntake: true,
  // Each turns true in the change that makes its route or request
  // form work; until then a client must not send it (contract §0.6).
  cumulativeHourBuckets: true,
  syncTriggerBackfill: true,
  biomarkerMerge: true,
  lifeCircumstances: true,
  // Apple Health ingest v2. The symptom batch, the built-in
  // symptom codes and the symptom delete route.
  appleHealthSymptoms: true,
  // The by-external-ids deletes for workouts, ECGs, cycle day-logs, mood
  // entries and doses, and `source: "APPLE_HEALTH"` + `externalId` on mood
  // writes. The routes shipped in 1.48.0; the flag names them.
  appleHealthDeletes: true,
  // The macro codes on `POST /api/nutrients/batch` (shipped in 1.48.0).
  nutrientMacros: true,
} as const;

/**
 * Patient-identity fields for the health-record export. The KVNR is
 * stored encrypted; decrypt fail-soft so a key-rotation gap on one row never
 * 500s the whole profile fetch (the field just reads null and the user
 * re-enters it).
 */
function readInsuranceNumber(encrypted: string | null | undefined) {
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch {
    return null;
  }
}
