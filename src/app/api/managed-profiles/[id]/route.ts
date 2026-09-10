import { NextRequest } from "next/server";

import {
  apiHandler,
  MFA_STEP_UP_MAX_AGE_SECONDS,
  requireCookieAuth,
  requireFreshMfa,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import {
  deleteManagedProfile,
  ManagedProfileLifecycleError,
  readManagedProfileForGuardian,
  updateManagedProfile,
} from "@/lib/managed-profiles/lifecycle";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { updateManagedProfileSchema } from "@/lib/validations/managed-profiles";

type RouteParams = { params: Promise<{ id: string }> };

/** The one refusal this file answers with for every "you may not have it". */
const notFound = () =>
  apiError("Managed profile not found", 404, {
    errorCode: "managed_profile.not_found",
  });

/**
 * The record as it stands.
 *
 * The read the edit form fills itself from, and the reason it exists at all:
 * `accountAccess.accounts` on the account payload carries a managed record's
 * NAME and nothing else, so a form offered from the Guardian's own panel had
 * no way to show the timezone, the language or the date of birth it was about
 * to overwrite. A form that opens with blank fields and PUTs them is how a
 * record loses its timezone to an edit of its name.
 *
 * Cookie-only and NOT step-up gated, exactly like the guardian roster beside
 * it and for the same reason: this is a read, it discloses to a Guardian what
 * they already administer, and the gate belongs to the acts. (Named
 * `requireCookieAuth` rather than described by the session helper it calls —
 * see the roster route's docblock for why that distinction is load-bearing.)
 *
 * An ACTOR surface: the profile is named in the path and the caller acts as
 * themselves, so it answers from the Guardian's own account rather than only
 * while switched into the record.
 */
export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireCookieAuth();
    const { id } = await params;

    const profile = await readManagedProfileForGuardian({
      profileId: id,
      guardianId: user.id,
    });
    // One refusal for "no such account", "not a managed profile" and "not a
    // Guardian of it", so the route is not an enumeration oracle.
    if (!profile) return notFound();

    annotate({
      action: { name: "managed_profile.read" },
      meta: { profile_id: id },
    });
    return apiSuccess(profile);
  },
);

/**
 * The ceiling the create sibling carries, on the act that changes what it
 * created. Ten an hour per caller: a person cannot mistype their way into ten
 * edits of a record's identity, and the number matching creation and guardian
 * invitation keeps one family answering one way.
 *
 * The GET beside it stays unlimited, matching the guardian roster read next to
 * it: both are cheap identity reads a Guardian may already make, and neither
 * family sibling has ever carried a read bucket.
 */
const UPDATE_LIMIT = 10;
const UPDATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Change a managed record's identity.
 *
 * ## Why the same gate as deletion
 *
 * `requireFreshMfa`, unconditionally, which is what creation and deletion
 * already carry. The three acts are one family: they mint, change and end an
 * account that can never prove anything about itself, so the proof has to come
 * from the person doing it. Softening the gate here — "it is only a rename" —
 * would leave the display name of every record somebody looks after writable
 * from an ambient cookie, and the display name is what every other Guardian,
 * the switcher and the record banner identify the record by.
 *
 * A Guardian who is already switched INTO the record edits the same five
 * columns through `PATCH /api/record-settings/profile` without a step-up, and
 * that is not a contradiction: reaching that surface at all requires the
 * switch, which is itself an act on the record. This route is the one reachable
 * from the Guardian's own panel, where nothing else has been proved.
 *
 * ## Which fields, and why not more
 *
 * The five the creation takes. Everything else a `User` row carries —
 * credentials, provider connections, notification routing, the health profile
 * — is deliberately out of reach: this is the record's identity, not its
 * account. The wider configuration surface is `PATCH
 * /api/record-settings/{family}`, which is guardian-fenced and switched-in.
 */
export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
    // Before the id is read, exactly as the create sibling does it. The cheap
    // refusal has to come first here for a second reason: `updateManagedProfile`
    // opens a transaction and takes an advisory lock on the id it was HANDED
    // before it decides the caller is not a Guardian of it, so an unthrottled
    // caller can name any id they like and make the database hold a lock about
    // it. Same ceiling as creating a record and inviting a Guardian — the three
    // acts are one family and answering the same abuse differently is the
    // asymmetry nobody notices until it is used.
    const rateLimit = await checkRateLimit(
      `managed-profile:update:${user.id}`,
      UPDATE_LIMIT,
      UPDATE_WINDOW_MS,
    );
    if (!rateLimit.allowed) {
      return apiError("Too many profile edits, try again later", 429);
    }
    const { id } = await params;

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 64 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = updateManagedProfileSchema.safeParse(body);
    if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

    // The parsed patch goes to the service, which assembles the Prisma payload
    // field by field. One assembly rather than one here and one there: two
    // statements of which fields are writable is one statement too many.
    let profile;
    try {
      profile = await updateManagedProfile({
        profileId: id,
        guardianId: user.id,
        patch: parsed.data,
      });
    } catch (error) {
      if (error instanceof ManagedProfileLifecycleError) return notFound();
      throw error;
    }

    annotate({
      action: { name: "managed_profile.update" },
      meta: { profile_id: id, changed: Object.keys(parsed.data) },
    });
    return apiSuccess(profile);
  },
);

/** Delete a managed record only after its cookie-backed Guardian proves MFA. */
export const DELETE = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
    const { id } = await params;

    try {
      await deleteManagedProfile({ profileId: id, guardianId: user.id });
    } catch (error) {
      if (error instanceof ManagedProfileLifecycleError) return notFound();
      throw error;
    }

    annotate({
      action: { name: "managed_profile.delete" },
      meta: { profile_id: id },
    });
    return apiSuccess({ deleted: true });
  },
);
