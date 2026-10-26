import { NextRequest } from "next/server";

import {
  apiHandler,
  MFA_STEP_UP_MAX_AGE_SECONDS,
  requireCookieAuth,
  requireFreshMfa,
} from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  listManagedProfileGuardians,
  toManagedProfileGuardianView,
} from "@/lib/managed-profiles/guardian-list";
import { ManagedProfileLifecycleError } from "@/lib/managed-profiles/lifecycle";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  GRANT_PARTY_SELECT,
  INVITE_NO_ACCOUNT_CODE,
} from "@/lib/sharing/grant-view";
import { GrantError, inviteManagedProfileGuardian } from "@/lib/sharing/grants";
import { inviteManagedProfileGuardianSchema } from "@/lib/validations/managed-profiles";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Who looks after this profile.
 *
 * The read the panel needs before it can offer to remove anybody, and the one
 * the last-Guardian floor is counted from before the click rather than
 * discovered as a 409 after it.
 *
 * Cookie-only, like every endpoint in this family, and for the same structural
 * reason: `requireCookieAuth` reads only the session cookie and never falls
 * through to the Bearer branch. (Named that way rather than by the session
 * helper it calls, because `session-surface-guard.test.ts` matches on the
 * helper's NAME in file text and a comment naming it enrols this route in a
 * list of files that resolve a session themselves. This one does not.)
 * Fresh MFA is deliberately NOT required — this
 * is a read, and it discloses nothing the caller cannot already read on their
 * own sharing panel about a party to a grant they hold. The gate belongs to the
 * acts, not to looking.
 *
 * An actor surface: the profile is named by the URL, and the caller acts as
 * themselves. `requireRecordAuth` / `requireGuardianAuth` would make the roster
 * answerable only while switched INTO the profile, which is backwards for a
 * panel whose whole purpose is to work from the Guardian's own account.
 */
export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireCookieAuth();
    const { id } = await params;

    const guardians = await listManagedProfileGuardians({
      profileId: id,
      callerId: user.id,
    });
    // One refusal for "no such account", "not a managed profile" and "you are
    // not a Guardian of it", so the route is not an enumeration oracle.
    if (guardians === null) {
      return apiError("Managed profile not found", 404, {
        errorCode: "managed_profile.not_found",
      });
    }

    annotate({
      action: { name: "managed_profile.guardian.list" },
      meta: { profile_id: id, guardian_count: guardians.length },
    });
    return apiSuccess(guardians);
  },
);

const INVITE_LIMIT = 10;
const INVITE_WINDOW_MS = 60 * 60 * 1000;

/** Invite another Guardian from a cookie-backed, freshly verified session. */
export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
    const rateLimit = await checkRateLimit(
      `managed-profile:guardian-invite:${user.id}`,
      INVITE_LIMIT,
      INVITE_WINDOW_MS,
    );
    if (!rateLimit.allowed) {
      return apiError("Too many invitations, try again later", 429);
    }
    const parsed = await parseJsonBody(
      request,
      inviteManagedProfileGuardianSchema,
      { maxBytes: 8 * 1024 },
    );
    if (!parsed.ok) return parsed.error;
    const { id } = await params;

    const invitee = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: parsed.data.identifier, mode: "insensitive" } },
          { email: { equals: parsed.data.identifier, mode: "insensitive" } },
        ],
      },
      select: GRANT_PARTY_SELECT,
    });
    // The same code the sibling invitation route (`POST /api/account/grants`)
    // answers an unknown identifier with. This route has a second 404 — "you
    // are not a Guardian of that profile", `managed_profile.not_found` — and
    // the two need different next steps, so each names itself and a client
    // never has to tell them apart by status.
    if (!invitee) {
      return apiError("No account with that name or e-mail", 404, {
        errorCode: INVITE_NO_ACCOUNT_CODE,
      });
    }

    try {
      const grant = await inviteManagedProfileGuardian({
        profileId: id,
        guardianId: user.id,
        granteeId: invitee.id,
        expiresAt: parsed.data.expiresAt
          ? new Date(parsed.data.expiresAt)
          : null,
      });
      annotate({
        action: { name: "managed_profile.guardian.invited" },
        meta: { profile_id: id, grant_id: grant.id },
      });
      // The roster's entry, not the grant row. A fresh invitation is always
      // PENDING, so the mapper cannot answer null here — but it decides that
      // rather than this route asserting it.
      const view = toManagedProfileGuardianView(grant, invitee);
      if (!view) throw new Error("A new invitation resolved to an ended grant");
      return apiSuccess(view, 201);
    } catch (error) {
      if (
        error instanceof GrantError &&
        error.code === "duplicate_live_grant"
      ) {
        return apiError("That account already has access", 409, {
          errorCode: "managed_profile.guardian.duplicate",
        });
      }
      // No arm for `self_grant`, and its absence is a decision. It fires when
      // the grantor equals the grantee; in this family the grantor is the
      // PROFILE, never the caller, so inviting yourself names somebody who is
      // not the grantor and lands on the duplicate refusal above, while naming
      // the profile itself is refused one step earlier as `managed_grantee`.
      // The 422 that used to sit here published `managed_profile.guardian.self`
      // — a code no request could elicit, on a route this release freezes. A
      // grant refusal nothing can produce is not caught into a sentence that
      // would then be wrong; it reaches the operator as a 500 with its wide
      // event, which is what an impossible state deserves.
      if (error instanceof ManagedProfileLifecycleError) {
        if (error.code === "managed_grantee") {
          return apiError("A managed profile cannot be a Guardian", 422, {
            errorCode: "managed_profile.guardian.managed_invitee",
          });
        }
        return apiError("Managed profile not found", 404, {
          errorCode: "managed_profile.not_found",
        });
      }
      throw error;
    }
  },
);
