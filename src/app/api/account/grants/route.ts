/**
 * `/api/account/grants` — the owner's side of account sharing.
 *
 * `GET` lists both directions at once: the grants this account has given, and
 * the grants it has received. One endpoint rather than two because they are
 * one question — "who can see my record, and whose can I see" — and because a
 * client that has to call twice will eventually render half an answer.
 *
 * `POST` offers a grant to somebody already registered on this instance, at
 * the level the owner chose and over the sections they chose. There is no
 * route that raises a live grant: both are settled when the invitation is
 * written and the only way to a wider one is a fresh invitation the delegate
 * accepts again.
 *
 * v1.37.0 — offering MANAGE is the one act on this surface with friction on
 * it. It asks for a fresh second factor when the account has one, which makes
 * it cookie-only by construction: the step-up gate resolves through the
 * session cookie and a token transport carries nothing that could satisfy it.
 * That consequence is deliberate rather than an oversight — the native client
 * cannot offer management of a health record, and the refusal below says so in
 * a code rather than leaving a token caller with an authentication error on a
 * request that authenticated fine.
 *
 * **Neither is delegable, and that is structural.** Both resolve through bare
 * `requireAuth()`, which refuses outright while the caller is acting on
 * another account. So a delegate cannot invite anybody into the record they
 * were given access to, cannot widen their own grant, and cannot pass it on:
 * the route does not have a re-delegation check that somebody could soften, it
 * has no code path that runs under a switch at all. The grantor is then taken
 * from the session on top of that — never from the body — so even if the mode
 * changed, the grant it wrote would be the caller's own record.
 *
 * On the enumeration question, stated plainly rather than left implicit: an
 * invitation to an unknown identifier is refused with "no such account", which
 * tells the inviter whether that person exists here. That is a disclosure, it
 * is deliberate, and the alternative is worse — an invite that silently goes
 * nowhere for a mistyped username leaves the owner staring at a pending row
 * that will never be accepted. The instance is a household, the caller is
 * already authenticated, and the rate limit below bounds how fast the surface
 * can be walked.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  requireAuth,
  requireFreshMfaIfEnrolled,
  MFA_STEP_UP_MAX_AGE_SECONDS,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { GRANT_PARTY_SELECT, toGrantView } from "@/lib/sharing/grant-view";
import { GrantError, inviteGrant } from "@/lib/sharing/grants";
import { inviteGrantSchema } from "@/lib/validations/account-sharing";

/**
 * Ten invitations an hour, per account.
 *
 * Generous for the household case (nobody invites their third family member
 * twice a minute) and tight enough that the account-existence disclosure above
 * cannot be turned into a user-directory dump.
 */
const INVITE_LIMIT = 10;
const INVITE_WINDOW_MS = 60 * 60 * 1000;

/** How much history a list call returns per direction. */
const MAX_GRANTS_PER_DIRECTION = 100;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "sharing.grants.list" } });

  const [given, received] = await Promise.all([
    prisma.accountGrant.findMany({
      where: { grantorId: user.id },
      orderBy: { createdAt: "desc" },
      take: MAX_GRANTS_PER_DIRECTION,
      include: { grantee: { select: GRANT_PARTY_SELECT } },
    }),
    prisma.accountGrant.findMany({
      where: { granteeId: user.id },
      orderBy: { createdAt: "desc" },
      take: MAX_GRANTS_PER_DIRECTION,
      include: { grantor: { select: GRANT_PARTY_SELECT } },
    }),
  ]);

  // Revoked and expired rows come back too. They are the consent record — "who
  // had access, from when to when, and who ended it" is the question the table
  // exists to answer, and a list that quietly dropped the ended rows would
  // leave the panel unable to answer it. `state` says which are live.
  const now = new Date();
  return apiSuccess({
    given: given.map((g) => toGrantView(g, g.grantee, now)),
    received: received.map((g) => toGrantView(g, g.grantor, now)),
  });
});

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireAuth();
  const user = auth.user;

  const rl = await checkRateLimit(
    `sharing:invite:${user.id}`,
    INVITE_LIMIT,
    INVITE_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many invitations, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 8 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = inviteGrantSchema.safeParse(rawBody);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "sharing.invite.invalid",
    });
  }

  const { identifier, expiresAt, access, scope } = parsed.data;

  // ── The step-up, and only on the level that needs one ───────────────────
  //
  // MANAGE is the level that can rewrite and delete somebody's health record,
  // so offering it is gated on a fresh second factor the way account deletion
  // and the encrypted export are. READ and WRITE are untouched: an owner
  // sharing a reading with their partner should not have to re-prove anything.
  //
  // It runs BEFORE the invitee lookup on purpose. That lookup answers 404 for
  // an identifier nobody carries, which is a deliberate disclosure to an
  // authenticated caller — but there is no reason to hand it out on a request
  // that is about to be refused anyway.
  //
  // The transport is checked first and separately. `requireFreshMfaIfEnrolled`
  // escalates to `requireFreshMfa`, which resolves through the session cookie
  // and has no Bearer fall-through; a token caller would therefore be told
  // "Not authenticated" by a route that had just authenticated them, which is
  // the obscure failure this branch exists to prevent. The consequence is
  // deliberate and documented (the native client cannot mint MANAGE): it is
  // said here in a code a client can branch on, so the app can send the person
  // to a browser instead of showing them a login error.
  if (access === "MANAGE") {
    if (auth.authMethod !== "cookie") {
      return apiError(
        "Manage access can only be offered from a browser session",
        403,
        { errorCode: "sharing.invite.manage_browser_only" },
      );
    }
    await requireFreshMfaIfEnrolled(MFA_STEP_UP_MAX_AGE_SECONDS);
  }

  // Either column, case-insensitively — the same lookup the login form does,
  // so the name somebody signs in with is the name they can be invited by.
  const invitee = await prisma.user.findFirst({
    where: {
      OR: [
        { email: { equals: identifier, mode: "insensitive" } },
        { username: { equals: identifier, mode: "insensitive" } },
      ],
    },
    select: GRANT_PARTY_SELECT,
  });
  if (!invitee) {
    return apiError("No account with that name or e-mail", 404);
  }

  try {
    // `inviteGrant` decides everything about the row except the level: the
    // self-grant refusal, and the one-live-grant-per-pair rule the partial
    // unique index backs. Neither is re-decided here. The level travels from
    // the parsed body, where the schema is the one place an omitted field
    // becomes READ, and it is fixed for the life of the row — the domain
    // module has no transition that raises it.
    const grant = await inviteGrant({
      grantorId: user.id,
      granteeId: invitee.id,
      access,
      // The sections the owner ticked, or null for the entire record. The
      // schema is where an absent field becomes null, the same way it is where
      // an absent level becomes READ; the domain module takes both as required
      // arguments so neither is decided twice. It re-refuses an empty set, an
      // unknown key and a scope beside MANAGE underneath this line — the
      // schema is the legible refusal, that one is the floor.
      scope: scope ?? null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });

    // The level AND the sections are on the audit row, not only in the
    // response: "who was given what, and by whom" is the question this row
    // exists to answer, and an entry that recorded the invitation without
    // either would answer half of it. `null` is written as null rather than
    // omitted, because "the entire record" is an answer and a missing key
    // would read as a row from before the question was asked.
    await auditLog("sharing.grant.invited", {
      userId: user.id,
      details: {
        grantId: grant.id,
        granteeId: invitee.id,
        access: grant.access,
        scope: scope ?? null,
      },
      ipAddress: getClientIp(request),
    }).catch(() => {});

    annotate({
      action: { name: "sharing.grant.invited" },
      meta: {
        grant_id: grant.id,
        access: grant.access,
        // The count rather than the keys: a dashboard wants to know how often
        // owners narrow, and which sections one household shares is not a
        // thing to spread across the observability pipeline. Zero means the
        // entire record.
        scope_sections: scope?.length ?? 0,
        expires: expiresAt !== null && expiresAt !== undefined,
      },
    });

    return apiSuccess(toGrantView(grant, invitee), 201);
  } catch (err) {
    if (err instanceof GrantError) return grantErrorResponse(err);
    throw err;
  }
});

/**
 * A refused transition, as an HTTP answer.
 *
 * The mapping lives here rather than inside the domain module because status
 * codes are a transport concern and the state machine is not — it hands back a
 * stable code and lets each consumer say what that means on its own wire.
 */
function grantErrorResponse(err: GrantError): Response {
  switch (err.code) {
    case "self_grant":
      return apiError("An account cannot be shared with itself", 422, {
        errorCode: "sharing.invite.self",
      });
    case "duplicate_live_grant":
      return apiError("That account already has access", 409, {
        errorCode: "sharing.invite.duplicate",
      });
    // The request shape refuses the same three cases earlier and more
    // legibly (a 422 naming the `scope` field). Reaching this arm means a
    // caller got past the schema with a scope the domain module will not
    // store — an empty set, a key outside the vocabulary, or any scope beside
    // MANAGE. Same status, its own code, so a client can tell "your sections
    // are wrong" from "that is your own account".
    case "invalid_scope":
      return apiError("Those sections cannot be shared", 422, {
        errorCode: "sharing.invite.invalid_scope",
      });
    default:
      return apiError("Invitation refused", 422, {
        errorCode: "sharing.invite.refused",
      });
  }
}
