/**
 * `/api/managed-profiles/[id]/handover` — the Guardian's side of handing a
 * managed profile over to the person it describes (v1.42, #959).
 *
 *   - `GET` reads whether a link is open, never the link itself (only its hash
 *     exists). Cookie-only, no step-up: it discloses to a Guardian what they
 *     already administer.
 *   - `POST` mints the one-time link with a proposal per Guardian. Step-up
 *     gated like every act that changes what a managed profile is
 *     (`requireFreshMfa`), and rate-limited like its siblings.
 *   - `DELETE` withdraws the open link. Cookie-only and NOT step-up gated:
 *     taking a link back must never be harder than handing it out.
 *
 * All three answer the same 404 for "no such profile", "not managed" and "not
 * a Guardian of it", so the route is not an enumeration oracle. Bearer tokens
 * cannot reach any of them: every gate here resolves the cookie session.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  MFA_STEP_UP_MAX_AGE_SECONDS,
  requireCookieAuth,
  requireFreshMfa,
} from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { buildHandoverUrl } from "@/lib/auth/handover-token";
import { annotate } from "@/lib/logging/context";
import { handoverMethods } from "@/lib/managed-profiles/claim-gate";
import {
  createHandover,
  HandoverError,
  readHandoverStatus,
  revokeHandover,
} from "@/lib/managed-profiles/handover";
import { checkRateLimit } from "@/lib/rate-limit";
import { createHandoverSchema } from "@/lib/validations/managed-profile-handover";

type RouteParams = { params: Promise<{ id: string }> };

const notFound = () =>
  apiError("Managed profile not found", 404, {
    errorCode: "managed_profile.not_found",
  });

/**
 * A link nobody could redeem is not minted. Since v1.43 the person can claim
 * through the identity provider, so a single-sign-on-only server hands over
 * too; this answers only when neither a password nor single sign-on is
 * possible, which a working configuration never produces.
 */
const noMethodRefusal = () =>
  apiError("Handing over a profile is not available on this server", 403, {
    errorCode: "profile_claim.oidc_only_unsupported",
  });

/** Same ceiling as creating, editing and inviting: ten an hour per caller. */
const CREATE_LIMIT = 10;
const CREATE_WINDOW_MS = 60 * 60 * 1000;

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireCookieAuth();
    const { id } = await params;

    const status = await readHandoverStatus({
      profileId: id,
      guardianId: user.id,
    });
    if (!status) return notFound();

    annotate({
      action: { name: "managed_profile.handover.read" },
      meta: { profile_id: id, open: status.open !== null },
    });
    const methods = handoverMethods();
    return apiSuccess({
      available: methods.length > 0,
      methods,
      open: status.open
        ? {
            id: status.open.id,
            createdAt: status.open.createdAt.toISOString(),
            expiresAt: status.open.expiresAt.toISOString(),
            createdByYou: status.open.createdByCaller,
          }
        : null,
    });
  },
);

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
    // Before the id is read and before any lock is taken, as the siblings do:
    // the service locks on the id it is handed before deciding the caller is
    // not a Guardian of it.
    const rateLimit = await checkRateLimit(
      `managed-profile:handover:${user.id}`,
      CREATE_LIMIT,
      CREATE_WINDOW_MS,
    );
    if (!rateLimit.allowed) {
      return apiError("Too many handover links, try again later", 429);
    }
    if (handoverMethods().length === 0) return noMethodRefusal();
    const { id } = await params;

    const parsed = await parseJsonBody(request, createHandoverSchema, {
      maxBytes: 16 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    let created;
    try {
      created = await createHandover({
        profileId: id,
        guardianId: user.id,
        expiresInDays: parsed.data.expiresInDays,
        proposals: parsed.data.proposals.map((p) => ({
          grantId: p.grantId,
          proposal: p.proposal,
        })),
      });
    } catch (error) {
      if (error instanceof HandoverError) {
        if (error.code === "unknown_guardian") {
          return apiError(
            "A proposal names somebody who is not a Guardian",
            422,
            {
              errorCode: "managed_profile.handover.unknown_guardian",
            },
          );
        }
        return notFound();
      }
      throw error;
    }

    annotate({
      action: { name: "managed_profile.handover.create" },
      meta: {
        profile_id: id,
        expires_in_days: parsed.data.expiresInDays,
        proposals: parsed.data.proposals.length,
      },
    });
    return apiSuccess(
      {
        id: created.id,
        token: created.token,
        url: buildHandoverUrl(created.token, request.url),
        expiresAt: created.expiresAt.toISOString(),
      },
      201,
    );
  },
);

export const DELETE = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireCookieAuth();
    const { id } = await params;

    let result;
    try {
      result = await revokeHandover({ profileId: id, guardianId: user.id });
    } catch (error) {
      if (error instanceof HandoverError) return notFound();
      throw error;
    }

    annotate({
      action: { name: "managed_profile.handover.revoke" },
      meta: { profile_id: id, revoked: result.revoked },
    });
    return apiSuccess(result);
  },
);
