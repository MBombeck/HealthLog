/**
 * OpenAPI route table — account sharing (v1.36.0).
 *
 * The lifecycle of one account's standing permission to read another's record:
 * the owner invites, the delegate accepts, either side ends it, and a browser
 * points itself at a record it has been granted.
 *
 * Two contract facts a client has to know and cannot derive:
 *
 *   * `POST /api/account/switch` is a browser-session feature. The Bearer
 *     transport carries its account selector in the `X-HealthLog-Account`
 *     header, per request, and gets a 400 from this endpoint — a token must
 *     never accumulate switch state, because the credential has to keep
 *     meaning "this person" for as long as it exists.
 *   * Every route here refuses while the caller is acting on another account
 *     (403, `meta.errorCode: "sharing.not_permitted"`), with the single
 *     exception of the switch endpoint, which is the way back out. A delegate
 *     cannot invite, widen, transfer, or end anybody's access from inside a
 *     record they were given.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { accountAccessBlockSchema } from "@/lib/sharing/account-access-schema";
import { SHARE_DOMAINS } from "@/lib/sharing/scope";
import {
  inviteGrantSchema,
  switchAccountSchema,
} from "@/lib/validations/account-sharing";
import {
  createManagedProfileSchema,
  inviteManagedProfileGuardianSchema,
  updateManagedProfileSchema,
} from "@/lib/validations/managed-profiles";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

/**
 * The four request bodies this table publishes, and the one thing to know about
 * writing another.
 *
 * `.meta()` does not annotate the schema it is called on. Zod 4 returns a NEW
 * schema carrying the metadata and registers THAT one, so a bare
 * `schema.meta({ id, description })` whose return value is dropped registers an
 * instance nothing references: the id never becomes a component, the
 * description never reaches the document, and the call site looks exactly like
 * a working one. These four were written that way, which is how the clause
 * below — the one scoping every rule on this endpoint to an INVITED grant —
 * came to be recorded in the source and absent from the artifact the native
 * client reads.
 *
 * So each one is bound to a const and the const is what the route references.
 * `openapi-account-sharing-components.test.ts` asserts every id declared in
 * this file reaches the built document, which is the assertion that would have
 * caught it.
 */
const accountGrantInvite = inviteGrantSchema.meta({
  id: "AccountGrantInvite",
  description:
    "Offer access to another account on this instance. Every sentence here describes an INVITED grant on this endpoint, and nothing else: a Guardian of a managed profile also holds MANAGE over a whole record, but that grant is minted by `POST /api/managed-profiles/{id}/guardians` under its own gate and answers with its own shape, so none of the rules below — the step-up, the transport, the refusals — may be carried across to it. `identifier` is the invitee's username or e-mail, matched case-insensitively — the same identifier they sign in with. `expiresAt` is optional; omitted or null means the grant runs until somebody ends it. `access` is READ when omitted, so a client that does not know about the field keeps working: READ can read the record and change nothing, WRITE can additionally ADD entries (readings, results, observations, a medication, a marked dose) and can still edit or delete nothing, including its own, and MANAGE can additionally change and remove entries, including ones the owner wrote, read the generated insights, and record the record's own health background (allergies, family history). The boundary is record content versus account configuration: MANAGE never reaches login, the second factor, provider connections, API tokens, notification routing, module and threshold configuration, or who else has access. `scope` narrows a READ or WRITE grant to named sections; omitted or null is the entire record, which is what every grant written before v1.37.0 means. An empty array, an unknown key, and any `scope` at all beside `access: MANAGE` are each 422 — management is whole-record by construction. Offering MANAGE additionally requires a fresh second factor when the account has one enrolled, which makes it cookie-only: a Bearer caller is refused with 403 `sharing.invite.manage_browser_only` and should send the person to a browser. The level and the scope are fixed when the invitation is written — no endpoint raises a live grant, because that would widen what the delegate accepted without asking them again. The way up is a new invitation the delegate accepts.",
});

const createManagedProfileRequest = createManagedProfileSchema.meta({
  id: "CreateManagedProfileRequest",
  description:
    "Create a health record for somebody who has no login of their own — a child, a dependent adult, an animal. The caller becomes its first Guardian in the same transaction, through an ordinary MANAGE grant with the new record as grantor, so the profile appears in `accountAccess.accounts` on the next `GET /api/auth/me` and is switched into like any other shared record. `displayName` is the only required text; `dateOfBirth` is an optional `YYYY-MM-DD` and is never synthesised from a year. `gender` is optional and takes the same three values `PATCH /api/auth/me` takes for an ordinary account (`MALE`, `FEMALE`, `OTHER`) or null; absent and null both mean not recorded, and the value is what the cycle module derives its default from, so a record created for a child who does not need it starts with it off. `locale` and `timezone` belong to the RECORD and not to the Guardian reading it: they decide how the profile's own reminders are worded and when its day starts. Strict — an unexpected field is a 422 rather than an ignored key. Cookie transport only and step-up gated (`requireFreshMfa`, unconditional): a Bearer caller cannot mint a credential-less person and a permanent management relationship, and an account with no second factor enrolled is refused rather than waved through. Rate-limited to ten an hour per caller.",
});

const updateManagedProfileRequest = updateManagedProfileSchema.meta({
  id: "UpdateManagedProfileRequest",
  description:
    "Change what a managed record is, from the Guardian's own panel. The same five fields creation takes, every one of them optional, and at least one required — an empty body is a 422 rather than a no-op that audits a change nobody made. Absence means leave the field alone; an explicit null on `dateOfBirth` or `gender` clears it, and the two are different answers. Nothing else on the record is reachable here: credentials, provider connections, notification routing and the health profile are not identity, and the wider configuration surface is `PATCH /api/record-settings/{family}`, which is guardian-fenced and answers only while switched into the record. Strict, cookie-only and step-up gated, like every act in this family.",
});

const inviteManagedProfileGuardianRequest =
  inviteManagedProfileGuardianSchema.meta({
    id: "InviteManagedProfileGuardianRequest",
    description:
      "Offer somebody else a share in looking after this profile. `identifier` is their username or e-mail, matched case-insensitively. `expiresAt` is an ISO instant WITH an offset — a bare `YYYY-MM-DD` is a 422 — or null for an invitation that runs until somebody ends it. The grant is created PENDING at MANAGE over the whole record; the invitee accepts it on their own invitations card exactly as they would any other, and until they do they do not satisfy the last-Guardian floor. Strict, cookie-only, step-up gated and rate-limited to ten an hour, like every act in this family.",
  });

const accountSwitchRequest = switchAccountSchema.meta({
  id: "AccountSwitchRequest",
  description:
    "Point this browser session at an account, or (with `accountId: null`) back at its own. Cookie transport only.",
});

const grantParty = z
  .object({
    id: z.string(),
    username: z.string(),
    displayName: z.string().nullable(),
  })
  .meta({
    id: "AccountGrantParty",
    description:
      "The account on the other end of a grant. E-mail addresses are deliberately not published: a grant is not a way to collect the other party's contact details.",
  });

const grantState = z.enum(["PENDING", "ACTIVE", "EXPIRED", "REVOKED"]).meta({
  id: "AccountGrantState",
  description:
    "What the grant is right now, resolved server-side against the request clock. Only ACTIVE confers anything. Ordering is stated rather than implied: a revoked grant reads REVOKED even if it also sat past its expiry, and an unaccepted invitation past its expiry reads EXPIRED rather than PENDING because it can no longer be accepted. Clients render this value and never re-derive it from the timestamps.",
});

const shareSection = z.enum(SHARE_DOMAINS).meta({
  id: "ShareSection",
  description:
    "One section of a health record, as a grant may name it. A closed vocabulary of eight, derived by clustering the delegable read surfaces rather than from the module list — the two answer different questions and never share a spelling. The whole-record case is `null` on the field that carries these, never a member of this enum: a scope that named the whole record would be a narrowing that means its own absence.",
});

const grantView = z
  .object({
    id: z.string(),
    account: grantParty,
    access: z.enum(["READ", "WRITE", "MANAGE"]),
    scope: z
      .array(shareSection)
      .nullable()
      .describe(
        "The sections this grant opens, or null for the entire record. Null is a first-class value and the one every grant written before v1.37.0 carries; render it as the whole record, never as a legacy or unknown state. A MANAGE grant always carries null. An EMPTY array means the grant opens nothing — the fail-closed reading of a stored scope the server cannot parse — and the server will refuse every section for it, so render it as nothing rather than as everything. Ordered by the consent screen's own reading order.",
      ),
    state: grantState,
    invitedAt: z.string(),
    acceptedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    revokedBy: z.enum(["GRANTOR", "GRANTEE"]).nullable(),
  })
  .meta({
    id: "AccountGrant",
    description:
      "One grant, from either side. The row is also the consent record — who offered the access, when it was accepted, when and by whom it ended — so ended grants stay in the list with `state: REVOKED` rather than disappearing. `revokedBy` distinguishes the owner withdrawing access from the delegate handing it back. `lastUsedAt` mirrors API-token semantics: the last time the grant was actually exercised.",
  });

const endedGrantView = grantView
  .extend({
    sessionsCleared: z
      .number()
      .int()
      .describe(
        "How many of the delegate's browser sessions were sitting inside the record and were put back into their own account, in the same transaction that ended the grant.",
      ),
  })
  .meta({
    id: "EndedAccountGrant",
    description:
      "A grant that has just been ended, plus what the cleanup did. Nothing is deleted: the row survives as the consent record and DELETE names the act, not the storage.",
  });

/**
 * v1.37.0 — one Guardian of a managed profile, as the roster publishes them.
 *
 * Deliberately narrower than {@link grantView}, and the narrowing is the
 * privacy decision rather than an omission. `access` and `scope` are constants
 * for a Guardian grant (MANAGE, whole record) and publishing a constant invites
 * a client to branch on it; `lastUsedAt`, `revokedAt` and `revokedBy` describe
 * a history this list is not about; and the party block is the same
 * `{ id, username, displayName }` one sharing party already sees of another,
 * with no e-mail.
 */
const managedProfileGuardian = z
  .object({
    grantId: z
      .string()
      .describe(
        "The grant row. This is the value `DELETE /api/managed-profiles/{id}/guardians/{grantId}` takes.",
      ),
    account: grantParty,
    state: z
      .enum(["PENDING", "ACTIVE"])
      .describe(
        "PENDING means the invitation has been sent and not yet accepted. A PENDING Guardian does NOT count toward the last-Guardian floor: the server counts accepted, unexpired MANAGE grants, so inviting somebody and then trying to leave is still refused until they accept. Say so before the act rather than letting it arrive as a 409.",
      ),
    invitedAt: z.string(),
    acceptedAt: z.string().nullable(),
  })
  .meta({
    id: "ManagedProfileGuardian",
    description:
      "One person who looks after a managed profile. Ended grants — revoked or expired — are absent rather than listed with a state: the question is who looks after this record now. The invitation route answers with this same shape, so a Guardian is described one way everywhere; it carries no `expiresAt`, because an expiry bounds one invitation rather than describing who is looking after the record.",
  });

const managedProfileCreated = z
  .object({
    id: z
      .string()
      .describe(
        "The profile's account id — the value `POST /api/account/switch` and the `X-HealthLog-Account` selector take, and the `{id}` in this family's paths.",
      ),
    displayName: z.string().nullable(),
    dateOfBirth: z
      .string()
      .nullable()
      .describe(
        "`YYYY-MM-DD`, or null. The same date-only shape the request takes — this is a calendar date, not an instant, and publishing it with a time would invite a client to apply a zone to it.",
      ),
    gender: z
      .enum(["MALE", "FEMALE", "OTHER"])
      .nullable()
      .describe(
        "`User.gender` for this record. Null means not recorded, which is a real answer and not a missing one.",
      ),
    locale: z
      .string()
      .nullable()
      .describe(
        "The record's own language. Every profile this family creates carries one, because creation requires it; the column is nullable, so null means a row written before that and a client renders its own language rather than the word.",
      ),
    timezone: z.string(),
    recordKind: z
      .literal("managed")
      .describe(
        "Always `managed` here. Published so a client can file the new record without re-deriving what it just created; the same value arrives on the account payload's entry for it.",
      ),
  })
  .meta({
    id: "ManagedProfile",
    description:
      "A record somebody looks after, as its creation, its read and its edit all answer with it. There is deliberately no list endpoint: the profiles a Guardian looks after are the `managed` entries of `accountAccess.accounts` on GET /api/auth/me, because a Guardian's relationship to a profile IS a MANAGE grant. Re-read the account payload after any change here; a client that refreshed only its own panel would leave the new record out of the switcher and the banner until the next boot.",
  });

const endedGuardianGrant = z
  .object({
    grantId: z.string(),
    revokedAt: z.string(),
  })
  .meta({
    id: "EndedManagedProfileGuardian",
    description:
      "What ended, and when. Two fields on purpose: who held it is on the roster the caller re-reads, and the grant row's remaining columns are storage rather than contract. Nothing is deleted — the row survives as the consent record with `revokedBy: GRANTOR`, the managed profile being the grantor of every Guardian grant.",
  });

const grantListResponse = z
  .object({
    given: z.array(grantView),
    received: z.array(grantView),
    retentionDays: z
      .number()
      .int()
      .describe(
        "How long the record's activity feed can still attribute an entry to the person who made it, in days. Resolved from the instance's audit retention setting (365 by default, operator-configurable), NOT a constant. It rides this payload so a client ending an access can state the window in the same breath, without a second request whose timing would decide whether the owner was told.",
      ),
  })
  .meta({
    id: "AccountGrantList",
    description:
      "Both directions at once: `given` are the grants this account has offered on its own record, `received` are the ones offered to it. Capped at 100 rows per direction, newest first.",
  });

/**
 * The record-session context, as the two surfaces a client may ADOPT one from
 * publish it.
 *
 * Both carry it in the response BODY, and that is the rule rather than a
 * coincidence: every other response reports its context in headers, and those
 * are for validating a response the client already has, never for learning one.
 * Two body-carrying sources, both actor surfaces that resolve canonical session
 * state, and no third path — which is why the 409 refusal below carries only an
 * error code and never the current epoch.
 */
const recordSessionState = z
  .object({
    epoch: z
      .number()
      .int()
      .describe(
        "How many times this browser session's record selector has moved. Monotonic, server-issued, and scoped to this session. Send it back as the `X-HealthLog-Record-Epoch` header on every subsequent same-origin request, and as `expectedEpoch` when switching.",
      ),
    scope: z
      .string()
      .nullable()
      .describe(
        "The account this session is pointed at, or null for its own record. Send it back as the `X-HealthLog-Record-Scope` header, with `self` standing for null.",
      ),
  })
  .meta({
    id: "RecordSessionState",
    description:
      "Where the record-session fence says this browser session is. Cookie transport only — null on Bearer, which carries its selector per request and accumulates no session state to be stale about. A client adopts this and then asserts it on every same-origin request, so a request formed under a context that has since moved is refused rather than served against the wrong record.",
  });

const switchResponse = z
  .object({
    recordSession: recordSessionState
      .nullable()
      .describe(
        "The context this session is now in, when the request supplied `expectedEpoch`. Null when it did not: an unconditional switch does not read the new epoch back, and a number computed client-side would be wrong the moment the target equalled the current selector. Adopt this value; do not derive it.",
      ),
    actingAs: z
      .object({
        accountId: z.string(),
        username: z.string(),
        displayName: z.string().nullable(),
        // The stored spelling, straight off the grant row the switch resolved
        // — not the lower-case resolved level the account payload publishes.
        // Two spellings of one fact is a wart this endpoint has carried since
        // v1.36.0; it is documented rather than papered over, because a client
        // reading either has to know which one it is holding.
        access: z.enum(["READ", "WRITE", "MANAGE"]),
      })
      .nullable(),
  })
  .meta({
    id: "AccountSwitchState",
    description:
      "The account this session is now acting on, or null when it is back in its own. The stamp is a selector and not a permission — the grant is re-checked on every subsequent request, so a revocation lands on the next one rather than at the next login.",
  });

const recordActivityEntry = z
  .object({
    id: z.string(),
    actor: grantParty
      .nullable()
      .describe(
        "Who did it. Null when that account has since been deleted — the audit column is deliberately not a foreign key, so history is not rewritten when somebody leaves. Render it as a deleted account; a blank would read as though the owner had done it themselves.",
      ),
    action: z.string(),
    accesses: z
      .number()
      .int()
      .nullable()
      .describe(
        "How many times that delegate opened the record on that day, for a coalesced read row. Null for anything else — a single act has no count, and a 1 there would invite adding up numbers that mean different things.",
      ),
    createdAt: z.string(),
  })
  .meta({ id: "RecordActivityEntry" });

const recordActivityResponse = z
  .object({
    entries: z.array(recordActivityEntry),
    retentionDays: z
      .number()
      .int()
      .describe(
        "How far back this feed can see, in days. Resolved from the instance's audit retention setting (365 by default, operator-configurable), NOT a constant — an instance running a 90-day window sends 90. The query is bounded to this window, so it is the real limit of the list and not only a caption. Show it beside the rows.",
      ),
    truncated: z
      .boolean()
      .describe(
        "True when the read reached its row ceiling, so `entries` is the most recent activity inside the window rather than all of it. A client must say so — a list that stops at its own cap in silence lets the oldest row read as the beginning. False means the list is everything inside the window.",
      ),
  })
  .meta({
    id: "RecordActivity",
    description:
      "The owner's record of what somebody else did in their record, bounded by the instance's audit retention.",
  });

const sharingRefusal = {
  description:
    "Refused. `meta.errorCode` is `sharing.not_permitted` when the request was made while acting on another account (grant management is never delegable), or `sharing.access.denied` when the caller may not act as the account they named. The latter is byte-identical for an account that does not exist and one that granted nothing — the refusal is not an enumeration oracle.",
  content: { "application/json": { schema: errorEnvelope } },
};

const recordSessionChanged = {
  description:
    "The record this browser session is on is not the record the request asserted. `meta.errorCode` is `sharing.session.changed`. It is not a refusal of access — the caller may well be entitled to both records — so do not leave the record and do not clear the session. Re-read GET /api/auth/me with a network-only request, adopt the `recordSession` it returns, and retry. The body deliberately carries no epoch or scope: a client may adopt a context from GET /api/auth/me and POST /api/account/switch only, and a refusal is not a third source of truth.",
  content: { "application/json": { schema: errorEnvelope } },
};

/**
 * The per-request account selector, published once.
 *
 * No route entry references it yet, and that is the honest state of the
 * contract: the routes that read a record other than the caller's own arrive
 * with the delegable-surface migration, and each one will `$ref` this
 * parameter as it lands. Publishing the selector now is what lets a native
 * client be built against a tagged spec rather than against a description of
 * one — the header is live in the resolver today, and a request that sends it
 * to a route which has not declared the mode is refused rather than quietly
 * served the caller's own data.
 *
 * Defined here rather than in the components block so the header's name stays
 * in two files, which `src/__tests__/acting-account-boundary-guard.test.ts`
 * holds it to: the resolver that reads it, and this one that publishes it.
 */
export const accountSelectorParameter: NonNullable<
  NonNullable<ZodOpenApiObject["components"]>["parameters"]
>[string] = {
  name: "X-HealthLog-Account",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 64 },
  description:
    "Act on another account's record for THIS request. Bearer transport only — the browser session carries its switch on the session row, and sending this header alongside a cookie is refused rather than ignored. The value is an `accountId` from `accountAccess.accounts` on GET /api/auth/me. It is a SELECTOR and not a permission: the grant is re-checked on every request, so a revocation lands on the next one rather than at the next login, and a selector naming an account that granted nothing is refused with 403 `sharing.access.denied` — byte-identical to one naming an account that does not exist, so the refusal is not an enumeration oracle. NEVER attach it to the sync engine, device or notification registration, or any auth/refresh call: those are about the person holding the token, not the record being read, and the account payload refuses the header outright for exactly that reason.",
};

/**
 * The record-session fence's two request headers, published once.
 *
 * Cookie transport only, and stated as such in both descriptions: a Bearer
 * client neither sends these nor receives them back, and the native contract is
 * unchanged by the fence in every direction. A browser client attaches both to
 * every same-origin request — there is no per-route opt-in, because a route
 * that had to remember is a route that will forget.
 *
 * Defined here rather than inline for the same reason the account selector
 * above is: `src/__tests__/record-session-fence-guard.test.ts` holds the header
 * names to exactly four files — the contract module that declares them, the
 * server fence that reads them, the client module that attaches them, and this
 * one, which publishes them.
 */
export const recordEpochParameter: NonNullable<
  NonNullable<ZodOpenApiObject["components"]>["parameters"]
>[string] = {
  name: "X-HealthLog-Record-Epoch",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 15 },
  description:
    "The record-session epoch this client believes it is on, taken from `recordSession.epoch` on GET /api/auth/me or POST /api/account/switch. Cookie transport only; a Bearer client neither sends nor receives it. Send the literal `bootstrap` before the account payload has resolved. A browser session that has never been pointed at another record is served without either header, which is what keeps a tab open across the deploy working. Once a session HAS entered a shared record it stays fenced permanently, in both directions: a mismatching epoch is refused with 409 `sharing.session.changed` (reconcile through GET /api/auth/me and retry), and an absent header is refused with 403 `sharing.access.denied` (a client predating the fence, which recovers by leaving the record and reloading).",
};

export const recordScopeParameter: NonNullable<
  NonNullable<ZodOpenApiObject["components"]>["parameters"]
>[string] = {
  name: "X-HealthLog-Record-Scope",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 64 },
  description:
    "The record this client believes it is inside, taken from `recordSession.scope`, with the literal `self` standing for one's own record. Sent alongside `X-HealthLog-Record-Epoch` on every same-origin request; one without the other is treated as a stale assertion, not as an absent one. Cookie transport only. Both headers are echoed back on any response that actually resolved a record scope, and a client discards a response whose echo contradicts the context it is now on — a response carrying no echo resolved no record scope and is served normally.",
};

// ── What the client is told it may do ────────────────────────────────────────

export const accountAccessBlock = accountAccessBlockSchema.meta({
  id: "AccountAccess",
  description:
    "Account sharing, resolved. This block is the ONLY source of switchability and writability: the server publishes what the caller may do and the client renders it. A client that computed either from grant data would be a second program deciding one person's access to a health record, and the two answer differently the first time an expiry or a revocation appears. Always present — an account nobody has shared with gets an empty list, not a missing field.",
});

/**
 * The account payload, documented for the one field this release adds.
 *
 * Loose on purpose. `GET /api/auth/me` has never been in this spec, and its
 * remaining fields are the account's own preference envelope — thirty-odd keys
 * that no contract has ever enumerated. Specifying `accountAccess` and
 * declaring the rest open is honest; enumerating a subset and closing the
 * object would publish a contract the server does not keep.
 */
const accountPayload = z
  .looseObject({
    id: z.string(),
    username: z.string(),
    accountAccess: accountAccessBlock,
    recordSession: recordSessionState.nullable(),
  })
  .meta({
    id: "AccountPayload",
    description:
      "The signed-in account: its identity, its preferences, and (since v1.36.0) what account sharing lets it do. Additional properties are the preference fields this spec does not yet enumerate. Under an active switch the identity and preference fields still describe the CALLER, because display preferences belong to the person at the keyboard rather than to the record they are reading. Two fields are the exception (v1.38.14): `modules` and `cycleTrackingEnabled` describe the ACTIVE RECORD, since every surface they gate shows the record's data — and they are masked to the sections the active grant opens, so a scoped grant reads `false` for a module outside it rather than the record's true state. With no switch — which is every native request, since the Bearer transport carries none — the two are the same account and nothing is masked.",
  });

/**
 * One envelope, three routes.
 *
 * `dataEnvelope` mints a new schema on every call, and two schemas cannot share
 * a component id — so creating, reading and editing a managed profile have to
 * reference the SAME const rather than call the helper three times. They do
 * describe the same thing, which is why they may.
 */
const managedProfileEnvelope = dataEnvelope(
  managedProfileCreated,
  "ManagedProfileEnvelope",
);

export const accountSharingPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/auth/me": {
    get: {
      tags: ["Auth"],
      summary: "The signed-in account, and what sharing lets it do",
      description:
        "Keeps answering while the browser is acting on another record — the switcher, the banner naming whose record is open, and the way back out all read it, so a refusal here would strand a switched session. It is therefore an ACTOR surface: it serves the caller's own rows — apart from `modules` and `cycleTrackingEnabled`, which answer for the record the session is inside, masked to what the grant opens — and a request that attaches `X-HealthLog-Account` is refused with 403 `sharing.not_permitted` rather than quietly answered. A client that wants a record's data sends the selector on the read that needs it, never on this call.",
      responses: {
        ...stdResponses,
        "200": {
          description: "The account payload.",
          content: {
            "application/json": {
              schema: dataEnvelope(accountPayload, "AccountPayloadEnvelope"),
            },
          },
        },
        "403": {
          description:
            "A selector header was attached to an actor surface (`meta.errorCode: sharing.not_permitted`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/account/activity": {
    get: {
      tags: ["Account sharing"],
      summary: "Who opened this record, and when",
      description:
        "Every audit row filed under this account that somebody else performed, newest first — one row per delegate per day with a count, rather than one per request. `retentionDays` rides the response because audit history is purged on a schedule the operator configures: a view that showed the rows without the window would imply a completeness it does not have, and clients must state the number the server sends rather than assume the 365-day default. Not delegable: a grant is not an introduction to the other people in the household.",
      responses: {
        ...stdResponses,
        "200": {
          description: "The activity, and how far back it can see.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                recordActivityResponse,
                "RecordActivityEnvelope",
              ),
            },
          },
        },
        "403": sharingRefusal,
      },
    },
  },
  "/api/account/grants": {
    get: {
      tags: ["Account sharing"],
      summary: "List grants in both directions",
      description:
        "Every grant this account has given or received, ended ones included. Refused while acting on another account.",
      responses: {
        ...stdResponses,
        "200": {
          description: "Grants given and received.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                grantListResponse,
                "AccountGrantListEnvelope",
              ),
            },
          },
        },
        "403": sharingRefusal,
      },
    },
    post: {
      tags: ["Account sharing"],
      summary: "Invite an account to this record",
      description:
        "Offers access to somebody already registered on this instance, at READ, WRITE or MANAGE and over the whole record or named sections; the grant confers nothing until they accept it. An identifier that names no account answers 404 — a deliberate disclosure to an authenticated caller on a household instance, rate-limited to 10 invitations an hour, and the alternative (a silent pending row for a mistyped username) is worse. Refused while acting on another account, so a delegate can neither invite nor re-delegate. Offering MANAGE is step-up gated (`requireFreshMfaIfEnrolled`, cookie-only): an enrolled account without a fresh factor gets 401 `auth.stepup.required`, and a Bearer caller gets 403 `sharing.invite.manage_browser_only` before anything else happens, because the gate it would hit resolves through the session cookie and would otherwise answer 'not authenticated' to a caller it had just authenticated.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: accountGrantInvite } },
      },
      responses: {
        ...stdResponses,
        "201": {
          description: "The pending grant.",
          content: {
            "application/json": {
              schema: dataEnvelope(grantView, "AccountGrantEnvelope"),
            },
          },
        },
        "401": {
          description:
            "Offering MANAGE from an MFA-enrolled account without a recent second-factor proof (`meta.errorCode: auth.stepup.required`). Re-prove the factor and retry; READ and WRITE invitations are never gated.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "403": {
          description:
            "Refused. `meta.errorCode` is `sharing.not_permitted` when the request was made while acting on another account (grant management is never delegable), or `sharing.invite.manage_browser_only` when a Bearer caller tried to offer MANAGE — the step-up that gates it is cookie-only by construction, so the native client cannot mint it and should route the person to a browser rather than surface an error.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "No account on this instance carries that identifier.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "That account already holds a live grant on this record (`meta.errorCode: sharing.invite.duplicate`). Re-inviting somebody whose access was revoked succeeds and mints a new row; the old one stays as history.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description:
            "Validation failed, the invitation named the caller's own account (`meta.errorCode: sharing.invite.self`), or the scope cannot mean anything (`meta.errorCode: sharing.invite.invalid_scope` from the domain module; the request-shape refusal for an empty array, an unknown section or a scope beside MANAGE arrives as the ordinary multi-issue envelope naming the `scope` field).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description: "Invitation rate limit exceeded.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/account/grants/{id}/accept": {
    post: {
      tags: ["Account sharing"],
      summary: "Accept an invitation",
      description:
        "The delegate's own act, and the consent record: it stamps the acceptance time and the accepting IP on the grant row. One-shot and delegate-only — the invited account comes from the session, so an invitation addressed to somebody else answers 404 rather than confirming it exists.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The now-active grant.",
          content: {
            "application/json": {
              schema: dataEnvelope(grantView, "AcceptedAccountGrantEnvelope"),
            },
          },
        },
        "403": sharingRefusal,
        "404": {
          description: "No such invitation for this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description: "Already accepted.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "410": {
          description: "The invitation lapsed or was withdrawn.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/account/grants/{id}": {
    delete: {
      tags: ["Account sharing"],
      summary: "Withdraw access (owner)",
      description:
        "Ends a grant on the caller's own record. No step-up and no confirmation step — reducing access must never be harder than granting it. Enforcement is the delegate's next request, not their next login, and the same transaction puts every browser session of theirs that was inside the record back into their own account. Nothing is deleted: the row survives with `revokedAt` and `revokedBy: GRANTOR`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The ended grant, and what the session cleanup did.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                endedGrantView,
                "RevokedAccountGrantEnvelope",
              ),
            },
          },
        },
        "403": sharingRefusal,
        "404": {
          description: "No such grant on this account's record.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "Two refusals share this status. `meta.errorCode: sharing.revoke.already_ended` — that access had already ended, and nothing changed. `meta.errorCode: managed_profile.guardian.required` — the grant is the last active Guardian grant on a managed profile, and ending it would leave a record with nobody able to open it. The floor is real and this is one of the four routes that enforce it; the way past it is to invite another Guardian and wait for them to accept, or to delete the profile.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/account/grants/{id}/renounce": {
    post: {
      tags: ["Account sharing"],
      summary: "Hand access back (delegate)",
      description:
        "The same transition as the owner's revoke, attributed the other way (`revokedBy: GRANTEE`) so the record can tell a withdrawal from a handover. Same session cleanup. Refused while acting on the record being renounced — switch back first (one request), which keeps grant management non-delegable without exceptions.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The ended grant, and what the session cleanup did.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                endedGrantView,
                "RenouncedAccountGrantEnvelope",
              ),
            },
          },
        },
        "403": sharingRefusal,
        "404": {
          description: "No such grant held by this account.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "Two refusals share this status. `meta.errorCode: sharing.renounce.already_ended` — that access had already ended, and nothing changed. `meta.errorCode: managed_profile.guardian.required` — the caller is the last active Guardian of a managed profile, so handing this access back would strand the record. Invite somebody and wait for them to accept, or delete the profile; a Guardian may not simply walk away from a record that has no self.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/managed-profiles": {
    post: {
      tags: ["Account sharing"],
      summary: "Create a record somebody looks after",
      description:
        "The one way a managed profile comes into existence. It has no password, no passkey and no second factor of its own, and it never gains one: an account with no self is reachable only through its Guardians, which is what makes the step-up below a boundary rather than a formality. The creator's own Guardian grant is minted in the same transaction, so the record is switchable immediately and the caller is never left holding a profile nobody administers. Cookie transport only — `requireFreshMfa` resolves through the session cookie, so a Bearer caller is refused as unauthenticated; a native client sends the person to a browser rather than surfacing that as an error.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createManagedProfileRequest },
        },
      },
      responses: {
        ...stdResponses,
        "201": {
          description: "The new record.",
          content: {
            "application/json": {
              schema: managedProfileEnvelope,
            },
          },
        },
        "401": {
          description:
            "No fresh second-factor proof (`meta.errorCode: auth.stepup.required`), or none enrolled at all (`meta.errorCode: auth.stepup.mfa_not_enrolled`) — this gate is unconditional, so an account without a second factor cannot create a managed profile until it enrols one. The ordinary unauthenticated 401 arrives here too, including for a Bearer caller, whose transport this gate does not read.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than ten profiles from one caller within the hour. No error code — rate-limit refusals carry none anywhere in this API; branch on the status. Nothing was created.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/managed-profiles/{id}": {
    get: {
      tags: ["Account sharing"],
      summary: "Read a managed record's identity",
      description:
        "What the record is right now — the five fields its creation took. The read an edit form fills itself from, and the reason it exists: `accountAccess.accounts` on the account payload carries the record's name and nothing else, so a form offered from the Guardian's own panel had no way to show the timezone, the language or the date of birth it was about to overwrite. Cookie transport only, an ACTOR surface (the profile is named in the path and the caller acts as themselves, so it answers without switching into the record), and NOT step-up gated: this is a read, it discloses to a Guardian only what they already administer, and the gate belongs to the acts.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The record as it stands.",
          content: {
            "application/json": {
              schema: managedProfileEnvelope,
            },
          },
        },
        "404": {
          description:
            "No such managed profile, or the caller is not one of its Guardians (`meta.errorCode: managed_profile.not_found`). The two are byte-identical, so the refusal is not an enumeration oracle.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
    patch: {
      tags: ["Account sharing"],
      summary: "Change a managed record's identity",
      description:
        "Edit the record after it exists — the name that was a placeholder, the timezone that moved with the household, the date of birth somebody finally has, the sex that decides whether the cycle module is on. Any active Guardian may do it, from a cookie session with a fresh second factor: the same gate creation and deletion carry, because the three acts mint, change and end an account that can never prove anything about itself. Answers with the whole record, so a client re-renders from the server's version rather than from what it sent.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateManagedProfileRequest },
        },
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The record as it now stands.",
          content: {
            "application/json": {
              schema: managedProfileEnvelope,
            },
          },
        },
        "401": {
          description:
            "No fresh second-factor proof, or none enrolled. Same unconditional gate as creation and deletion.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description:
            "No such managed profile, or the caller is not one of its Guardians (`meta.errorCode: managed_profile.not_found`). The two are byte-identical.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
    delete: {
      tags: ["Account sharing"],
      summary: "Delete a managed record",
      description:
        "Ends the record and everything in it. This is the documented way OUT of the last-Guardian floor, which is why it carries no last-Guardian refusal of its own: a Guardian may not strand a record with nobody looking after it, but they may end the record. Any active Guardian may do it, from a cookie session with a fresh second factor.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The record is gone.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.literal(true) }),
                "DeletedManagedProfileEnvelope",
              ),
            },
          },
        },
        "401": {
          description:
            "No fresh second-factor proof, or none enrolled. Same unconditional gate as creation.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description:
            "No such managed profile, or the caller is not one of its Guardians (`meta.errorCode: managed_profile.not_found`). The two are byte-identical, so the refusal is not an enumeration oracle — and an ordinary record whose owner granted somebody MANAGE is not a managed profile, so it answers here too.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/managed-profiles/{id}/guardians": {
    get: {
      tags: ["Account sharing"],
      summary: "Who looks after a managed profile",
      description:
        "The live Guardians of one managed profile — every unexpired, unrevoked MANAGE grant on it, PENDING and ACTIVE alike. Cookie transport only, by the same structural argument as the rest of this family: it resolves through the session and never falls through to the Bearer branch. A fresh second factor is NOT required, unlike every act on the same profile: this is a read, and it discloses nothing about a party the caller cannot already read on their own sharing panel. An ACTOR surface — the profile is named in the path and the caller acts as themselves, so it answers from the Guardian's own account rather than only while switched into the record. Anyone who is not an active Guardian of THIS profile gets the same 404 as an unknown id, including a READ, WRITE or MANAGE delegate of an ordinary record: the refusal is not an enumeration oracle. Count the ACTIVE rows to know whether removing a Guardian is possible — a PENDING invitation does not satisfy the last-Guardian floor.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The profile's live Guardians, oldest invitation first.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(managedProfileGuardian),
                "ManagedProfileGuardianListEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No such managed profile, or the caller is not one of its Guardians (`meta.errorCode: managed_profile.not_found`). The two are byte-identical.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
    post: {
      tags: ["Account sharing"],
      summary: "Invite another Guardian",
      description:
        "Offers somebody else a share in looking after this profile, at MANAGE over the whole record. Cookie-only and step-up gated, like every act in this family — the read beside it is not. **Resolve refusals on `meta.errorCode` first and fall back to the status only for the two arms that carry none**, because this route answers 404 twice and the codeless one is the less serious of the two: an identifier that matches no account carries no code, while `managed_profile.not_found` means the caller is not a Guardian of that profile at all. A client branching on the status first would tell somebody to check a spelling when the real answer is that the record is no longer theirs to administer.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: inviteManagedProfileGuardianRequest,
          },
        },
      },
      responses: {
        ...stdResponses,
        "201": {
          description:
            "The pending Guardian, in the shape the roster publishes.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                managedProfileGuardian,
                "ManagedProfileGuardianEnvelope",
              ),
            },
          },
        },
        "401": {
          description:
            "No fresh second-factor proof, or none enrolled. Same unconditional gate as creation.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description:
            "Two refusals share this status and only one carries a code. **No `meta.errorCode`**: no account on this instance carries that identifier — the same deliberate disclosure to an authenticated caller that `POST /api/account/grants` makes, and codeless there too, so this family does not answer one way here and another way one page over. `meta.errorCode: managed_profile.not_found`: no such managed profile, or the caller is not one of its Guardians.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "That account already holds a live grant on this record (`meta.errorCode: managed_profile.guardian.duplicate`). Inviting YOURSELF lands here rather than on a refusal of its own: a Guardian grant's grantor is the profile, never the caller, so naming yourself names an account that already has access — which is both true and the useful sentence.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description:
            "Validation failed (the multi-issue envelope; a bare `YYYY-MM-DD` expiry arrives here), or the invitee is itself a managed profile (`meta.errorCode: managed_profile.guardian.managed_invitee`) — a record with no self cannot look after another one.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than ten invitations from one caller within the hour. No error code, as above; branch on the status.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/managed-profiles/{id}/guardians/{grantId}": {
    delete: {
      tags: ["Account sharing"],
      summary: "End another Guardian's access",
      description:
        "Ends one Guardian grant on this profile — a pending invitation or an accepted one. Another person's, never the caller's own: the service refuses a target grant whose grantee is the caller, and that refusal is the same 404 an unknown profile gets, so a self-removal control would be a button that always fails with a sentence describing something else. A Guardian steps away through `POST /api/account/grants/{id}/renounce` instead, which carries the last-Guardian refusal properly. Count the ACTIVE rows on the roster BEFORE offering this: the floor is stated ahead of the act rather than discovered as a refusal, and on this route it cannot arrive as one — see the 409.",
      requestParams: {
        path: z.object({ id: z.string(), grantId: z.string() }),
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "What ended, and when.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                endedGuardianGrant,
                "EndedManagedProfileGuardianEnvelope",
              ),
            },
          },
        },
        "401": {
          description:
            "No fresh second-factor proof, or none enrolled. Same unconditional gate as creation.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description:
            "`meta.errorCode: managed_profile.not_found`, for four situations the caller cannot tell apart: no such profile, no such grant on it, the caller is not one of its Guardians, or the target grant is the caller's OWN. The last is the one to design around — a client must not offer this control on the caller's own row, because the refusal it earns describes a missing profile rather than what actually happened.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The record would be left with nobody looking after it (`meta.errorCode: managed_profile.guardian.required`). **Not reachable through this route today**, and published anyway rather than silently: the caller must already be one active Guardian and the target is never the caller, so an active target is always a second one — and two is never the one the floor refuses. The routes that DO emit this code are `DELETE /api/account/grants/{id}` (the owner withdrawing the last Guardian grant), `POST /api/account/grants/{id}/renounce` (a Guardian handing their own access back), Guardian account deletion and a data wipe — a client resolves the code the same way wherever it arrives, which is why this arm stays. It is documented here so that a change making it reachable through this route is a change somebody notices.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/account/switch": {
    post: {
      tags: ["Account sharing"],
      summary: "Act on a granted record, or return to your own",
      description:
        "Cookie transport only; a Bearer caller gets 400 (`meta.errorCode: sharing.switch.wrong_transport`) and should send the `X-HealthLog-Account` header on the requests it wants scoped instead. The grant is validated here so the client gets an honest refusal immediately, but the stamp authorises nothing on its own — every following request re-checks the grant. `accountId: null` clears the switch and always works, including from inside a switched session: this endpoint is the way out, and it is deliberately not fenced for that reason — a session whose context cannot be proved must still be able to leave. Supply `expectedEpoch` to make the write conditional: two tabs switching at once resolve to one monotonic outcome, and the loser is refused with 409 `sharing.session.changed` rather than silently overwriting the winner. Reconcile through GET /api/auth/me and retry once against the reconciled epoch.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: accountSwitchRequest } },
      },
      responses: {
        ...stdResponses,
        "200": {
          description: "The account this session is now acting on, or null.",
          content: {
            "application/json": {
              schema: dataEnvelope(switchResponse, "AccountSwitchEnvelope"),
            },
          },
        },
        "400": {
          description:
            "Sent over the Bearer transport, which carries its selector per request instead.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "403": sharingRefusal,
        "409": recordSessionChanged,
        "422": {
          description: "Validation failed.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
