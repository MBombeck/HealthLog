/**
 * Every mutation and read the managed-profile surface can issue, through the
 * real routes and a real Postgres.
 *
 * The browser card is proved from a static render in
 * `src/components/settings/access/__tests__/managed-profile-affordances.test.tsx`,
 * which can say that a control exists and nothing about what happens when it is
 * pressed. This file is the other half: the same calls the card makes, against
 * the handlers themselves, including every refusal the card renders a sentence
 * for.
 *
 * The roster read is where most of the weight sits, because it is the one
 * capability this release adds to the server. Its field set is asserted with
 * `Object.keys` rather than by presence: an over-disclosing route passes every
 * "contains" assertion ever written about it, and the decision that the roster
 * publishes no e-mail address is a privacy decision rather than plumbing.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar, queuedSessionIds } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";
import { createManagedProfile } from "@/lib/managed-profiles/create";
import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";
import { bodyWithoutRequestId } from "@/__tests__/helpers/error-envelope";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-managed-profile-surface-32-bytes-min-1234509876";

const { hashToken } = await import("@/lib/auth/hmac");

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar, queuedSessionIds } =
    await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => {
      const snapshot = new Map(cookieJar);
      const queuedSessionId = queuedSessionIds.shift();
      if (queuedSessionId) {
        snapshot.set("healthlog_session", queuedSessionId);
      }
      return {
        get: (name: string) => {
          const value = snapshot.get(name);
          return value ? { name, value } : undefined;
        },
        set: (name: string, value: string) => {
          cookieJar.set(name, value);
        },
        delete: (name: string) => {
          cookieJar.delete(name);
        },
      };
    }),
  };
});

let sequence = 0;

interface Person {
  id: string;
  username: string;
  sessionId: string;
}

/** An account with a second factor and a session that has just proved it. */
async function person(label: string): Promise<Person> {
  const suffix = sequence++;
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
      totpConfirmedAt: new Date(),
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      mfaVerifiedAt: new Date(),
    },
  });
  return { id: user.id, username: user.username, sessionId: session.id };
}

function signIn(who: Person): void {
  headerJar.delete("authorization");
  cookieJar.set("healthlog_session", who.sessionId);
}

/** A wildcard Bearer token for `who`, with no cookie session armed. */
async function signInWithBearer(who: Person): Promise<void> {
  const raw = `hlk_surface_${"0".repeat(48)}`;
  await getPrismaClient().apiToken.create({
    data: {
      userId: who.id,
      name: "surface",
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
  });
  cookieJar.clear();
  headerJar.set("authorization", `Bearer ${raw}`);
}

async function listGuardians(profileId: string) {
  const { GET } =
    await import("@/app/api/managed-profiles/[id]/guardians/route");
  return GET(
    new NextRequest(
      `http://localhost/api/managed-profiles/${profileId}/guardians`,
      { method: "GET" },
    ),
    { params: Promise.resolve({ id: profileId }) },
  );
}

/** `POST /api/managed-profiles`, with the body the card composes. */
async function createProfile(body: unknown) {
  const { POST } = await import("@/app/api/managed-profiles/route");
  return POST(
    new NextRequest("http://localhost/api/managed-profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function deleteProfile(profileId: string) {
  const { DELETE } = await import("@/app/api/managed-profiles/[id]/route");
  return DELETE(
    new NextRequest(`http://localhost/api/managed-profiles/${profileId}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: profileId }) },
  );
}

async function inviteGuardian(
  profileId: string,
  body: { identifier: string; expiresAt?: string | null },
) {
  const { POST } =
    await import("@/app/api/managed-profiles/[id]/guardians/route");
  return POST(
    new NextRequest(
      `http://localhost/api/managed-profiles/${profileId}/guardians`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ id: profileId }) },
  );
}

async function removeGuardian(profileId: string, grantId: string) {
  const { DELETE } =
    await import("@/app/api/managed-profiles/[id]/guardians/[grantId]/route");
  return DELETE(
    new NextRequest(
      `http://localhost/api/managed-profiles/${profileId}/guardians/${grantId}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ id: profileId, grantId }) },
  );
}

async function errorCodeOf(response: Response): Promise<unknown> {
  return (await response.json()).meta?.errorCode;
}

/** A profile with its creator as sole Guardian, plus a pending second one. */
async function profileWithPendingSecondGuardian() {
  const creator = await person("creator");
  const invitee = await person("invitee");
  const { profile } = await createManagedProfile({
    creatorId: creator.id,
    displayName: "Managed record",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  const invitation = await inviteGrant({
    grantorId: profile.id,
    granteeId: invitee.id,
    access: "MANAGE",
    scope: null,
  });
  return { creator, invitee, profile, invitation };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  queuedSessionIds.length = 0;
});

describe("who looks after a managed profile (real Postgres)", () => {
  it("shows an active Guardian every live grant, pending and accepted", async () => {
    const { creator, invitee, profile } =
      await profileWithPendingSecondGuardian();
    signIn(creator);

    const response = await listGuardians(profile.id);
    expect(response.status).toBe(200);
    const roster = (await response.json()).data as Array<
      Record<string, unknown>
    >;

    expect(roster).toHaveLength(2);
    const byName = new Map(
      roster.map((row) => [
        (row.account as { username: string }).username,
        row,
      ]),
    );
    expect(byName.get(creator.username)?.state).toBe("ACTIVE");
    expect(byName.get(creator.username)?.acceptedAt).toEqual(
      expect.any(String),
    );
    expect(byName.get(invitee.username)?.state).toBe("PENDING");
    expect(byName.get(invitee.username)?.acceptedAt).toBeNull();
  });

  it("discloses exactly five fields, and the party block carries no e-mail", async () => {
    // `Object.keys`, not `toContain`. A route that also published the
    // invitee's e-mail address, their notification channels or their last
    // access would satisfy every presence assertion in this file.
    const { profile, creator } = await profileWithPendingSecondGuardian();
    signIn(creator);

    const roster = (await (await listGuardians(profile.id)).json())
      .data as Array<Record<string, unknown>>;
    expect(roster.length).toBeGreaterThan(0);
    for (const row of roster) {
      expect(Object.keys(row).sort()).toEqual([
        "acceptedAt",
        "account",
        "grantId",
        "invitedAt",
        "state",
      ]);
      expect(Object.keys(row.account as object).sort()).toEqual([
        "displayName",
        "id",
        "username",
      ]);
    }
  });

  it("answers a second Guardian with the same roster", async () => {
    const { creator, invitee, profile, invitation } =
      await profileWithPendingSecondGuardian();
    await acceptGrant({ grantId: invitation.id, granteeId: invitee.id });

    signIn(creator);
    const first = (await (await listGuardians(profile.id)).json()).data;
    signIn(invitee);
    const second = (await (await listGuardians(profile.id)).json()).data;

    expect(second).toEqual(first);
    expect(
      (second as Array<{ state: string }>).every((r) => r.state === "ACTIVE"),
    ).toBe(true);
  });

  it("refuses somebody who is not a Guardian of that profile", async () => {
    const { profile } = await profileWithPendingSecondGuardian();
    const stranger = await person("stranger");
    signIn(stranger);

    const response = await listGuardians(profile.id);
    expect(response.status).toBe(404);
    expect((await response.json()).meta?.errorCode).toBe(
      "managed_profile.not_found",
    );
  });

  it("answers an unknown id with the same bytes as a refused one", async () => {
    // The refusal must not be an enumeration oracle: "no such profile" and
    // "not yours" have to be indistinguishable from the outside.
    const { profile } = await profileWithPendingSecondGuardian();
    const stranger = await person("stranger");
    signIn(stranger);

    // `meta.requestId` is a fresh id per request and says nothing about the
    // profile; every other byte has to match.
    const refusedRes = await listGuardians(profile.id);
    const unknownRes = await listGuardians("does-not-exist");
    expect(unknownRes.status).toBe(refusedRes.status);
    const refused = await refusedRes.clone().json();
    const unknown = await unknownRes.clone().json();
    expect(typeof refused.meta?.requestId).toBe("string");
    expect(typeof unknown.meta?.requestId).toBe("string");
    expect(await bodyWithoutRequestId(unknownRes)).toBe(
      await bodyWithoutRequestId(refusedRes),
    );
  });

  it.each(["READ", "WRITE", "MANAGE"] as const)(
    "refuses a %s delegate of an ordinary record against that record",
    async (access) => {
      // Holding a grant is not holding this read. An adult record whose owner
      // granted MANAGE is not a managed profile, and must 404 exactly as an
      // unknown id does.
      const owner = await person("owner");
      const delegate = await person("delegate");
      const invitation = await inviteGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
        access,
        scope: null,
      });
      await acceptGrant({ grantId: invitation.id, granteeId: delegate.id });
      signIn(delegate);

      const response = await listGuardians(owner.id);
      expect(response.status).toBe(404);
      expect((await response.json()).meta?.errorCode).toBe(
        "managed_profile.not_found",
      );
    },
  );

  it("drops a revoked Guardian from the roster and refuses them the read", async () => {
    const { creator, invitee, profile, invitation } =
      await profileWithPendingSecondGuardian();
    await acceptGrant({ grantId: invitation.id, granteeId: invitee.id });
    await getPrismaClient().accountGrant.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
    });

    signIn(invitee);
    expect((await listGuardians(profile.id)).status).toBe(404);

    signIn(creator);
    const roster = (await (await listGuardians(profile.id)).json())
      .data as Array<{ account: { username: string } }>;
    expect(roster).toHaveLength(1);
    expect(roster[0].account.username).toBe(creator.username);
  });

  it("drops an expired Guardian grant from the roster", async () => {
    const { creator, profile, invitation } =
      await profileWithPendingSecondGuardian();
    await getPrismaClient().accountGrant.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    signIn(creator);
    const roster = (await (await listGuardians(profile.id)).json())
      .data as Array<{ account: { username: string } }>;
    expect(roster).toHaveLength(1);
    expect(roster[0].account.username).toBe(creator.username);
  });

  it("refuses a Bearer caller, because the family is cookie-only", async () => {
    const { creator, profile } = await profileWithPendingSecondGuardian();
    await signInWithBearer(creator);

    // The same account, the same wildcard reach it has everywhere else, and
    // still no answer here: `requireCookieAuth` never falls through to the
    // Bearer branch.
    expect((await listGuardians(profile.id)).status).toBe(401);
  });
});

describe("every call the managed-profile card can make", () => {
  it("cannot be reached with a token, however wide its permissions", async () => {
    // The native half of the contract, and the reason the freeze can promise
    // it: `requireFreshMfa` resolves the session cookie and never falls
    // through to the Bearer branch, so a wildcard token — the widest a client
    // can hold — cannot mint a credential-less person and a permanent
    // management relationship. The positive control is the very next case:
    // the same body, from a cookie session that has proved its factor,
    // creates the record.
    const creator = await person("creator");
    await signInWithBearer(creator);

    const response = await createProfile({
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    expect(response.status).toBe(401);
    expect(
      await getPrismaClient().user.count({
        where: { managedProfileAt: { not: null } },
      }),
    ).toBe(0);
  });

  it("creates a profile from exactly the body the form composes", async () => {
    const creator = await person("creator");
    signIn(creator);

    const response = await createProfile({
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "de",
      timezone: "Europe/Zurich",
    });
    expect(response.status).toBe(201);
    const created = (await response.json()).data;
    expect(created.recordKind).toBe("managed");

    // The creator is its Guardian, accepted, from the same transaction — which
    // is why the card can read the profile off the account payload rather than
    // from a list endpoint that does not exist.
    signIn(creator);
    const roster = (await (await listGuardians(created.id)).json())
      .data as Array<{ state: string; account: { id: string } }>;
    expect(roster).toEqual([
      expect.objectContaining({
        state: "ACTIVE",
        account: expect.objectContaining({ id: creator.id }),
      }),
    ]);
  });

  it("refuses a body carrying a field the form does not collect", async () => {
    // The schema is `.strict()`. This is the reason the client names its four
    // fields one at a time instead of spreading its form state: a helpful
    // extra key is a 422 about something nobody filled in.
    signIn(await person("creator"));
    const response = await createProfile({
      displayName: "Managed record",
      locale: "en",
      timezone: "UTC",
      heightCm: 120,
    });
    expect(response.status).toBe(422);
  });

  it("refuses a display name that is only whitespace", async () => {
    // The bound the form mirrors before it sends: the route trims first.
    signIn(await person("creator"));
    expect(
      (
        await createProfile({
          displayName: "   ",
          locale: "en",
          timezone: "UTC",
        })
      ).status,
    ).toBe(422);
  });

  it("deletes a profile, and answers a second attempt with the same 404", async () => {
    const { creator, profile } = await profileWithPendingSecondGuardian();
    signIn(creator);

    expect((await deleteProfile(profile.id)).status).toBe(200);
    expect(
      await getPrismaClient().user.findUnique({ where: { id: profile.id } }),
    ).toBeNull();

    const second = await deleteProfile(profile.id);
    expect(second.status).toBe(404);
    expect(await errorCodeOf(second)).toBe("managed_profile.not_found");
  });

  it("refuses deletion by somebody who is not a Guardian", async () => {
    const { profile } = await profileWithPendingSecondGuardian();
    signIn(await person("stranger"));

    const response = await deleteProfile(profile.id);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe("managed_profile.not_found");
    // And the record is still there.
    expect(
      await getPrismaClient().user.findUnique({ where: { id: profile.id } }),
    ).not.toBeNull();
  });

  it("invites a second Guardian as PENDING, with the offset expiry the form sends", async () => {
    const creator = await person("creator");
    const invitee = await person("invitee");
    signIn(creator);
    const { profile } = await createManagedProfile({
      creatorId: creator.id,
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });

    // The shape `endOfDayIso` produces: an ISO instant, offset-bearing. A bare
    // `YYYY-MM-DD` is a 422 here, which is why the client never sends the date
    // field's raw value.
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const response = await inviteGuardian(profile.id, {
      identifier: invitee.username,
      expiresAt,
    });
    expect(response.status).toBe(201);
    const grant = (await response.json()).data;
    expect(grant.acceptedAt).toBeNull();

    // Read the stored row, because the entry the route answers with does not
    // carry the expiry: a Guardian is published in one shape everywhere, and
    // that shape is the roster's five fields. Asserting the column is the
    // stronger claim anyway — it proves the offset instant was persisted
    // rather than that it was echoed.
    const stored = await getPrismaClient().accountGrant.findUniqueOrThrow({
      where: { id: grant.grantId },
      select: { expiresAt: true },
    });
    expect(stored.expiresAt?.toISOString()).toBe(expiresAt);

    // PENDING, and therefore not counted by the floor — which is the sentence
    // the card states before anybody tries to leave.
    const roster = (await (await listGuardians(profile.id)).json())
      .data as Array<{ state: string }>;
    expect(roster.filter((r) => r.state === "ACTIVE")).toHaveLength(1);
    expect(roster.filter((r) => r.state === "PENDING")).toHaveLength(1);
  });

  it("accepts the body the client actually composes, field names and all", async () => {
    // Both ends and the pipe between them. The route's schema is `.strict()`,
    // so a client that renamed `identifier` would be refused with a 422 — and
    // a test that posted a hand-written copy of the body would stay green
    // through exactly that rename. This posts the composer's own output.
    const { guardianInviteBody } =
      await import("@/lib/queries/use-managed-profiles");
    const creator = await person("creator");
    const invitee = await person("invitee");
    signIn(creator);
    const { profile } = await createManagedProfile({
      creatorId: creator.id,
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });

    const body = guardianInviteBody({
      profileId: profile.id,
      identifier: invitee.username,
      expiresAt: null,
    });
    // Non-zero proof, deliberately name-agnostic: an empty body would be
    // refused for the wrong reason and would make the 201 below prove nothing.
    // The NAMES are proved by the route accepting it, not by a second copy of
    // them written here.
    expect(Object.keys(body)).toHaveLength(2);

    const response = await inviteGuardian(
      profile.id,
      body as { identifier: string; expiresAt: string | null },
    );
    expect(response.status).toBe(201);
    expect((await response.json()).data.acceptedAt).toBeNull();
  });

  it("answers an invitation with the roster's shape, not the grant row", async () => {
    // `Object.keys`, for the same reason the roster read asserts it that way:
    // the handler used to answer with the `AccountGrant` row straight out of
    // Prisma — `grantorId`, `granteeId`, `scopeJson`, `lastUsedAt` and the
    // rest — and every presence assertion in this file passed while it did.
    // The invitation now answers with the entry the roster publishes, so one
    // shape describes a Guardian everywhere and the published contract does
    // not pin a table's columns to the wire.
    const creator = await person("creator");
    const invitee = await person("invitee");
    signIn(creator);
    const { profile } = await createManagedProfile({
      creatorId: creator.id,
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });

    const response = await inviteGuardian(profile.id, {
      identifier: invitee.username,
      expiresAt: null,
    });
    expect(response.status).toBe(201);

    const entry = (await response.json()).data as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual([
      "acceptedAt",
      "account",
      "grantId",
      "invitedAt",
      "state",
    ]);
    expect(Object.keys(entry.account as object).sort()).toEqual([
      "displayName",
      "id",
      "username",
    ]);
    expect(entry.state).toBe("PENDING");
    expect((entry.account as { username: string }).username).toBe(
      invitee.username,
    );

    // The pipe, not the ends: the entry the invitation answered with is the
    // entry the roster read answers with a moment later.
    const roster = (await (await listGuardians(profile.id)).json())
      .data as Array<Record<string, unknown>>;
    expect(roster).toContainEqual(entry);
  });

  it("answers a removal with the access it ended and when", async () => {
    const { creator, profile, invitation } =
      await profileWithPendingSecondGuardian();
    signIn(creator);

    const response = await removeGuardian(profile.id, invitation.id);
    expect(response.status).toBe(200);

    const ended = (await response.json()).data as Record<string, unknown>;
    expect(Object.keys(ended).sort()).toEqual(["grantId", "revokedAt"]);
    expect(ended.grantId).toBe(invitation.id);
    expect(ended.revokedAt).toEqual(expect.any(String));
  });

  it("refuses a bare calendar date as an expiry", async () => {
    const creator = await person("creator");
    const invitee = await person("invitee");
    signIn(creator);
    const { profile } = await createManagedProfile({
      creatorId: creator.id,
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    expect(
      (
        await inviteGuardian(profile.id, {
          identifier: invitee.username,
          expiresAt: "2027-01-30",
        })
      ).status,
    ).toBe(422);
  });

  it("answers an invitation addressed to yourself with the duplicate refusal", async () => {
    // NOT `managed_profile.guardian.self`, and the plan predicted otherwise.
    // `self_grant` fires when the grantor equals the grantee, and the grantor
    // here is the PROFILE — never the caller. So inviting yourself is simply
    // an account that already has access, which is what the person is told,
    // and the route's 422 self arm cannot be reached. Recorded as a finding;
    // the client has no arm for a code the server cannot send.
    const { creator, profile } = await profileWithPendingSecondGuardian();
    signIn(creator);
    const response = await inviteGuardian(profile.id, {
      identifier: creator.username,
    });
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe(
      "managed_profile.guardian.duplicate",
    );
  });

  it("cannot be made to answer the self-invitation 422 either", async () => {
    // The other door to `self_grant` is naming the profile itself, and that
    // one is closed by the managed-invitee check one line earlier. Both paths
    // are asserted so the arm is known to be dead rather than assumed to be.
    const { creator, profile } = await profileWithPendingSecondGuardian();
    signIn(creator);
    const response = await inviteGuardian(profile.id, {
      identifier: profile.username,
    });
    expect(response.status).toBe(422);
    expect(await errorCodeOf(response)).toBe(
      "managed_profile.guardian.managed_invitee",
    );
  });

  it("refuses an invitation to somebody who already has access", async () => {
    const { creator, invitee, profile } =
      await profileWithPendingSecondGuardian();
    signIn(creator);
    const response = await inviteGuardian(profile.id, {
      identifier: invitee.username,
    });
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe(
      "managed_profile.guardian.duplicate",
    );
  });

  it("refuses a managed profile as a Guardian", async () => {
    const { creator, profile } = await profileWithPendingSecondGuardian();
    const { profile: other } = await createManagedProfile({
      creatorId: creator.id,
      displayName: "Second record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    signIn(creator);
    const response = await inviteGuardian(profile.id, {
      identifier: other.username,
    });
    expect(response.status).toBe(422);
    expect(await errorCodeOf(response)).toBe(
      "managed_profile.guardian.managed_invitee",
    );
  });

  it("answers an unknown identifier with a 404 that names itself", async () => {
    // This route has a second 404 (`managed_profile.not_found`) with a
    // different next step, so the unknown name carries its own code and a
    // client never has to tell the two apart by status.
    const { creator, profile } = await profileWithPendingSecondGuardian();
    signIn(creator);
    const response = await inviteGuardian(profile.id, {
      identifier: "nobody-here",
    });
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe("sharing.invite.no_account");
  });

  it("refuses an invitation from somebody who is not a Guardian", async () => {
    const { profile, invitee } = await profileWithPendingSecondGuardian();
    signIn(await person("stranger"));
    const response = await inviteGuardian(profile.id, {
      identifier: invitee.username,
    });
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe("managed_profile.not_found");
  });

  it("ends another Guardian's access and clears their switched sessions", async () => {
    const { creator, invitee, profile, invitation } =
      await profileWithPendingSecondGuardian();
    await acceptGrant({ grantId: invitation.id, granteeId: invitee.id });
    signIn(creator);

    const response = await removeGuardian(profile.id, invitation.id);
    expect(response.status).toBe(200);
    expect(
      await getPrismaClient().accountGrant.findUniqueOrThrow({
        where: { id: invitation.id },
      }),
    ).toMatchObject({ revokedBy: "GRANTOR" });

    // And the roster the card re-reads no longer carries them.
    const roster = (await (await listGuardians(profile.id)).json())
      .data as unknown[];
    expect(roster).toHaveLength(1);
  });

  it("withdraws a pending invitation without touching the accepted count", async () => {
    const { creator, profile, invitation } =
      await profileWithPendingSecondGuardian();
    signIn(creator);

    expect((await removeGuardian(profile.id, invitation.id)).status).toBe(200);
    const roster = (await (await listGuardians(profile.id)).json())
      .data as Array<{ state: string }>;
    expect(roster).toHaveLength(1);
    expect(roster[0].state).toBe("ACTIVE");
  });

  it("refuses a Guardian ending their OWN access, and leaves the grant alone", async () => {
    // This is the shape the card's missing self-removal control comes from.
    // `revokeManagedProfileGuardian` refuses a target whose grantee is the
    // caller, and the route turns that into `managed_profile.not_found` — NOT
    // into the last-Guardian 409. A self-removal button would therefore be one
    // that always fails, with a message that does not describe what happened.
    // Stepping away is the renounce control on the shared-access panel.
    const { creator, profile } = await profileWithPendingSecondGuardian();
    const own = await getPrismaClient().accountGrant.findFirstOrThrow({
      where: { grantorId: profile.id, granteeId: creator.id },
    });
    signIn(creator);

    const response = await removeGuardian(profile.id, own.id);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe("managed_profile.not_found");
    expect(
      await getPrismaClient().accountGrant.findUniqueOrThrow({
        where: { id: own.id },
      }),
    ).toMatchObject({ revokedAt: null, revokedBy: null });
  });

  it("refuses removal by somebody who is not a Guardian of the profile", async () => {
    const { profile, invitation } = await profileWithPendingSecondGuardian();
    signIn(await person("stranger"));
    const response = await removeGuardian(profile.id, invitation.id);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe("managed_profile.not_found");
  });

  it("cannot be made to answer the last-Guardian 409 through this route", async () => {
    // Recorded as a property rather than as a gap in coverage. The refusal
    // fires only when the TARGET is active and the accepted count is at most
    // one — and the caller must be an accepted Guardian to get this far, and
    // may not target themselves. Two accepted Guardians is therefore the
    // minimum for the branch to be evaluated at all, and two is never one.
    //
    // The floor is real; it is enforced on the renounce route, on account
    // deletion and on a data wipe. It is this ROUTE that cannot express it,
    // which is why the card states the floor from the roster instead of
    // waiting for a refusal that will not come.
    const { creator, invitee, profile, invitation } =
      await profileWithPendingSecondGuardian();
    await acceptGrant({ grantId: invitation.id, granteeId: invitee.id });
    signIn(creator);

    // Two accepted Guardians: the removal is allowed rather than refused.
    expect((await removeGuardian(profile.id, invitation.id)).status).toBe(200);

    // And with one left, the only target available to that Guardian is
    // themselves — which is the 404 above, not the 409.
    const own = await getPrismaClient().accountGrant.findFirstOrThrow({
      where: { grantorId: profile.id, granteeId: creator.id },
    });
    const self = await removeGuardian(profile.id, own.id);
    expect(self.status).toBe(404);
    expect(await errorCodeOf(self)).not.toBe(
      "managed_profile.guardian.required",
    );
  });
});

describe("the three caller states the roster read has to refuse", () => {
  it("refuses a Guardian whose invitation has not been accepted", async () => {
    // PENDING confers nothing. `activeGuardianWhere` requires `acceptedAt`, so
    // an invitee who can see the invitation on their own panel still cannot
    // read the roster of the record it is for — and must not be able to, or
    // an invitation would disclose the household before it was accepted.
    const { invitee, profile } = await profileWithPendingSecondGuardian();
    signIn(invitee);

    const response = await listGuardians(profile.id);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe("managed_profile.not_found");
  });

  it("refuses a Guardian whose grant has expired", async () => {
    // The other half of the same predicate, and the one a `revokedAt IS NULL`
    // check alone would miss: nobody ended this grant, the clock did.
    const { invitee, profile, invitation } =
      await profileWithPendingSecondGuardian();
    await acceptGrant({ grantId: invitation.id, granteeId: invitee.id });
    await getPrismaClient().accountGrant.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    signIn(invitee);

    const response = await listGuardians(profile.id);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe("managed_profile.not_found");
  });

  it("refuses a holder of MANAGE on an ordinary record, against a real managed profile", async () => {
    // Distinct from the leg above that points a delegate at THEIR OWN grantor:
    // this caller holds a live MANAGE grant somewhere, and aims it at somebody
    // else's managed profile. Holding the level is not holding this record.
    const { profile } = await profileWithPendingSecondGuardian();
    const owner = await person("owner");
    const manager = await person("manager");
    const invitation = await inviteGrant({
      grantorId: owner.id,
      granteeId: manager.id,
      access: "MANAGE",
      scope: null,
    });
    await acceptGrant({ grantId: invitation.id, granteeId: manager.id });
    signIn(manager);

    const response = await listGuardians(profile.id);
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe("managed_profile.not_found");
  });
});

describe("what deletion does to a Guardian who is standing inside the record", () => {
  it("puts their session back in their own account rather than nowhere", async () => {
    // The composition worth an integration leg: `Session.actingAsUserId` is a
    // foreign key with ON DELETE SET NULL, and the epoch is bumped by a
    // database trigger on that column. Deleting the profile therefore has to
    // leave the other Guardian's browser in a state it can prove — back in
    // their own record, on a NEW epoch — rather than pointed at a row that is
    // gone. A session left holding a dangling selector is the shape that
    // strands somebody behind the fence with no way out.
    const { creator, invitee, profile, invitation } =
      await profileWithPendingSecondGuardian();
    await acceptGrant({ grantId: invitation.id, granteeId: invitee.id });
    await switchSessionTo(invitee.sessionId, profile.id);

    const before = await getPrismaClient().session.findUniqueOrThrow({
      where: { id: invitee.sessionId },
    });
    // Non-zero proof: they really were inside the record before the delete.
    expect(before.actingAsUserId).toBe(profile.id);

    signIn(creator);
    expect((await deleteProfile(profile.id)).status).toBe(200);

    const after = await getPrismaClient().session.findUniqueOrThrow({
      where: { id: invitee.sessionId },
    });
    // The session survives — deleting a record must not sign anybody out —
    // and it is back in its own account.
    expect(after.actingAsUserId).toBeNull();
    // And the context moved, so a request formed inside the deleted record is
    // refused as stale rather than served against nothing.
    expect(after.recordEpoch).toBeGreaterThan(before.recordEpoch);
  });
});

describe("how many profiles one account may create in an hour", () => {
  it("refuses the eleventh, with the same ceiling the guardian route carries", async () => {
    // Ten an hour. The guardian invitation has been bounded since it shipped;
    // this route creates a real account row per call and was not, which is the
    // kind of asymmetry between two endpoints of one family that nobody
    // notices until it is used.
    const creator = await person("creator");
    signIn(creator);

    for (let i = 0; i < 10; i += 1) {
      const allowed = await createProfile({
        displayName: `Managed record ${i}`,
        locale: "en",
        timezone: "UTC",
      });
      expect(allowed.status, `creation ${i}`).toBe(201);
    }

    const refused = await createProfile({
      displayName: "One too many",
      locale: "en",
      timezone: "UTC",
    });
    expect(refused.status).toBe(429);
    // The status default. A 429 has one meaning in this family (wait), so the
    // client branches on the status and needs no code of its own.
    expect(await errorCodeOf(refused)).toBe("http.rate_limited");
    // And nothing was created by the refused call.
    expect(
      await getPrismaClient().user.count({
        where: { managedProfileAt: { not: null } },
      }),
    ).toBe(10);
  });

  it("bounds the caller and not the instance", async () => {
    // A per-user bucket, so one busy account cannot stop another from creating
    // a record. `checkRateLimit` is keyed by caller id; this proves the key
    // really carries it rather than being a single global bucket.
    const first = await person("creator");
    signIn(first);
    for (let i = 0; i < 10; i += 1) {
      await createProfile({
        displayName: `Managed record ${i}`,
        locale: "en",
        timezone: "UTC",
      });
    }
    expect(
      (
        await createProfile({
          displayName: "One too many",
          locale: "en",
          timezone: "UTC",
        })
      ).status,
    ).toBe(429);

    const second = await person("creator");
    signIn(second);
    expect(
      (
        await createProfile({
          displayName: "Somebody else's first",
          locale: "en",
          timezone: "UTC",
        })
      ).status,
    ).toBe(201);
  });
});
