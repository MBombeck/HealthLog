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

import { SHARE_DOMAINS } from "@/lib/sharing/scope";
import {
  inviteGrantSchema,
  switchAccountSchema,
} from "@/lib/validations/account-sharing";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

inviteGrantSchema.meta({
  id: "AccountGrantInvite",
  description:
    "Offer access to another account on this instance. `identifier` is the invitee's username or e-mail, matched case-insensitively — the same identifier they sign in with. `expiresAt` is optional; omitted or null means the grant runs until somebody ends it. `access` is READ when omitted, so a client that does not know about the field keeps working: READ can read the record and change nothing, WRITE can additionally ADD entries (readings, results, observations, a medication, a marked dose) and can still edit or delete nothing, including its own, and MANAGE can additionally change and remove entries, including ones the owner wrote, and read the generated insights — never the identity surfaces (login, second factor, connections, tokens, settings, or who else has access). `scope` narrows a READ or WRITE grant to named sections; omitted or null is the entire record, which is what every grant written before v1.37.0 means. An empty array, an unknown key, and any `scope` at all beside `access: MANAGE` are each 422 — management is whole-record by construction. Offering MANAGE additionally requires a fresh second factor when the account has one enrolled, which makes it cookie-only: a Bearer caller is refused with 403 `sharing.invite.manage_browser_only` and should send the person to a browser. The level and the scope are fixed when the invitation is written — no endpoint raises a live grant, because that would widen what the delegate accepted without asking them again. The way up is a new invitation the delegate accepts.",
});

switchAccountSchema.meta({
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

const grantListResponse = z
  .object({
    given: z.array(grantView),
    received: z.array(grantView),
  })
  .meta({
    id: "AccountGrantList",
    description:
      "Both directions at once: `given` are the grants this account has offered on its own record, `received` are the ones offered to it. Capped at 100 rows per direction, newest first.",
  });

const switchResponse = z
  .object({
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
        "How far back this feed can see, in days. Resolved from the instance's audit retention setting (365 by default, operator-configurable), NOT a constant — an instance running a 90-day window sends 90. Show it beside the rows.",
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

// ── What the client is told it may do ────────────────────────────────────────

const accountAccessEntry = z
  .object({
    accountId: z
      .string()
      .describe(
        "The account whose record it is — the value POST /api/account/switch takes, and the value the X-HealthLog-Account header carries.",
      ),
    username: z.string(),
    displayName: z.string().nullable(),
    access: z
      .enum(["read", "write", "manage"])
      .describe(
        "The grant's resolved level, under the name v1.36.0 published. Identical to `level` — both come from one server-side expression — and kept because shipped clients read it. New code reads `level`.",
      ),
    level: z
      .enum(["read", "write", "manage"])
      .describe(
        "The grant's resolved level. `manage` additionally admits changing and removing entries on the delegable surfaces; it never reaches the identity surfaces (settings, connections, tokens, consent, grant management), which stay refused on an invited record at every level. Render it; never derive it from `canWrite`.",
      ),
    sections: z
      .array(shareSection)
      .nullable()
      .describe(
        "The sections of that record this caller may open, or null for the entire record. Null is first-class and is what every pre-v1.37.0 grant carries; a MANAGE grant always carries it too. A non-null array names the open sections and NOTHING else answers — a client that switches into a scoped record without honouring this gets the standard 403 on every out-of-scope route, fail-closed and byte-identical to every other sharing refusal, which is safe but reads as a wall of errors. An empty array means the grant opens nothing. Ordered by the consent screen's reading order.",
      ),
    canWrite: z
      .boolean()
      .describe(
        "Whether this caller may ADD to that record: true for an accepted WRITE or MANAGE grant, false for a READ one. On its own it never means edit or delete — a WRITE grant adds and does nothing more. What MANAGE additionally admits is said by `level`. Resolved server-side. Render it; never derive it.",
      ),
  })
  .meta({
    id: "AccountAccessEntry",
    description:
      "One account this caller may act on. No avatar is published: the avatar bytes are owner-scoped, so a URL here would resolve to a refusal. Clients paint their initials fallback.",
  });

export const accountAccessBlock = z
  .object({
    accounts: z
      .array(accountAccessEntry)
      .describe("Every record this caller may open, newest grant first."),
    active: accountAccessEntry
      .nullable()
      .describe(
        "The record this session is inside right now, resolved to a full entry rather than an id to look up — so a banner can name the person without joining two fields. Null when the caller is in their own record, and ALWAYS null on the Bearer transport: a token carries its selector per request and this endpoint refuses one.",
      ),
    canSwitch: z
      .boolean()
      .describe("Whether there is anywhere to switch to. Bind it directly."),
  })
  .meta({
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
  })
  .meta({
    id: "AccountPayload",
    description:
      "The signed-in account: its identity, its preferences, and (since v1.36.0) what account sharing lets it do. Additional properties are the preference fields this spec does not yet enumerate. Under an active switch this payload still describes the CALLER — their preferences, their modules, their identity — because display preferences belong to the person at the keyboard rather than to the record they are reading.",
  });

export const accountSharingPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/auth/me": {
    get: {
      tags: ["Auth"],
      summary: "The signed-in account, and what sharing lets it do",
      description:
        "Keeps answering while the browser is acting on another record — the switcher, the banner naming whose record is open, and the way back out all read it, so a refusal here would strand a switched session. It is therefore an ACTOR surface: it always serves the caller's own rows, and a request that attaches `X-HealthLog-Account` is refused with 403 `sharing.not_permitted` rather than quietly answered. A client that wants a record's data sends the selector on the read that needs it, never on this call.",
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
        content: { "application/json": { schema: inviteGrantSchema } },
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
          description: "That access had already ended.",
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
          description: "That access had already ended.",
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
        "Cookie transport only; a Bearer caller gets 400 (`meta.errorCode: sharing.switch.wrong_transport`) and should send the `X-HealthLog-Account` header on the requests it wants scoped instead. The grant is validated here so the client gets an honest refusal immediately, but the stamp authorises nothing on its own — every following request re-checks the grant. `accountId: null` clears the switch and always works, including from inside a switched session: this endpoint is the way out.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: switchAccountSchema } },
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
        "422": {
          description: "Validation failed.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
