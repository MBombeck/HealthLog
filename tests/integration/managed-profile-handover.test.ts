/**
 * v1.42 (#959) — handing a managed profile over to the person it describes,
 * through the real routes and a real Postgres.
 *
 * Every request body is composed by the CLIENT's own builder
 * (`handoverCreateBody`, `claimBody`, `handoverDecisionBody`), so a renamed
 * field on either end fails here rather than in production.
 *
 * What is proved, in the order a handover happens:
 *
 *   - the link: shown once, stored only as a hash, at most one open per
 *     profile, withdrawable, expiring, single-use, dead with its creator;
 *   - the gate on minting it: cookie and a fresh second factor, never Bearer;
 *   - the claim: one transaction that sets credentials, clears the marker,
 *     withdraws pending invitations, applies each proposal, resets disclaimer,
 *     onboarding and AI consent, audits every step and consumes the token —
 *     and a failure anywhere in it leaves the profile exactly as it was;
 *   - the races that matter: two claims, a claim against a new link, a claim
 *     against the profile's deletion;
 *   - the anonymous surface: uniform 404, live-session 409, rate limit, and
 *     the refusal on a single-sign-on-only instance;
 *   - the new owner's decision afterwards, including a restored MANAGE and a
 *     row that moved since the claim and is left alone.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { hashToken } from "@/lib/auth/hmac";
import { verifyPassword } from "@/lib/auth/password";
import { createManagedProfile } from "@/lib/managed-profiles/create";
import {
  acceptGrant,
  GrantError,
  inviteGrant,
  renounceGrantAndClearSwitch,
  revokeManagedProfileGuardian,
} from "@/lib/sharing/grants";
import { deleteManagedProfile } from "@/lib/managed-profiles/lifecycle";
import {
  claimManagedProfile,
  createHandover,
} from "@/lib/managed-profiles/handover";
import { resolveManagedGuardianRecipientIds } from "@/lib/notifications/delivery-identity";
import { handoverCreateBody } from "@/lib/queries/use-managed-profiles";
import { claimBody } from "@/lib/queries/use-profile-claim";
import { handoverDecisionBody } from "@/lib/queries/use-handover-decision";
import type { HandoverAccess } from "@/lib/managed-profiles/handover-access";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// The breach corpus is a network call; the claim's own logic is the subject.
vi.mock("@/lib/password-breach-check", () => ({
  checkPasswordBreachIfEnabled: vi.fn().mockResolvedValue(null),
}));

// The outbox. Guardians are told on their own channels; what is sent, to
// whom, is read back from here instead of from a mail server.
const sent: { userId: string; titleKey: string; messageKey: string }[] = [];
vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn(
    async (opts: { userId: string; titleKey: string; messageKey: string }) => {
      sent.push({
        userId: opts.userId,
        titleKey: opts.titleKey,
        messageKey: opts.messageKey,
      });
    },
  ),
}));

const PASSWORD = "correct horse battery staple 1959";

let sequence = 0;

interface Person {
  id: string;
  username: string;
  sessionId: string;
}

/** An account with a second factor and a session that has just proved it. */
async function person(label: string, freshMfa = true): Promise<Person> {
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
      mfaVerifiedAt: freshMfa ? new Date() : null,
    },
  });
  return { id: user.id, username: user.username, sessionId: session.id };
}

function signIn(who: Person): void {
  headerJar.delete("authorization");
  cookieJar.set("healthlog_session", who.sessionId);
}

function signOut(): void {
  cookieJar.clear();
  headerJar.delete("authorization");
}

/** A profile with two active Guardians: its creator and one more. */
async function household() {
  const creator = await person("creator");
  const second = await person("second");
  const { profile, creatorGrant } = await createManagedProfile({
    creatorId: creator.id,
    displayName: "Robin",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  const invitation = await inviteGrant({
    grantorId: profile.id,
    granteeId: second.id,
    access: "MANAGE",
    scope: null,
  });
  const secondGrant = await acceptGrant({
    grantId: invitation.id,
    granteeId: second.id,
  });
  return { creator, second, profile, creatorGrant, secondGrant };
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function mint(
  profileId: string,
  proposals: { grantId: string; proposal: HandoverAccess }[] = [],
  expiresInDays: 1 | 7 | 14 = 7,
) {
  const { POST } =
    await import("@/app/api/managed-profiles/[id]/handover/route");
  return POST(
    new NextRequest(
      `http://localhost/api/managed-profiles/${profileId}/handover`,
      json(handoverCreateBody({ profileId, expiresInDays, proposals })),
    ),
    { params: Promise.resolve({ id: profileId }) },
  );
}

async function mintToken(
  profileId: string,
  proposals: { grantId: string; proposal: HandoverAccess }[] = [],
): Promise<string> {
  const response = await mint(profileId, proposals);
  expect(response.status).toBe(201);
  const { data } = await response.json();
  return data.token as string;
}

async function status(profileId: string) {
  const { GET } =
    await import("@/app/api/managed-profiles/[id]/handover/route");
  return GET(
    new NextRequest(
      `http://localhost/api/managed-profiles/${profileId}/handover`,
    ),
    { params: Promise.resolve({ id: profileId }) },
  );
}

async function withdraw(profileId: string) {
  const { DELETE } =
    await import("@/app/api/managed-profiles/[id]/handover/route");
  return DELETE(
    new NextRequest(
      `http://localhost/api/managed-profiles/${profileId}/handover`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ id: profileId }) },
  );
}

async function preview(token: string) {
  const { POST } = await import("@/app/api/auth/claim/preview/route");
  return POST(
    new NextRequest("http://localhost/api/auth/claim/preview", json({ token })),
  );
}

async function claim(token: string, overrides: { username?: string } = {}) {
  const suffix = sequence++;
  const { POST } = await import("@/app/api/auth/claim/route");
  return POST(
    new NextRequest(
      "http://localhost/api/auth/claim",
      json(
        claimBody({
          token,
          username: overrides.username ?? `robin${suffix}`,
          email: `robin-${suffix}@example.test`,
          password: PASSWORD,
        }),
      ),
    ),
  );
}

async function readDecision() {
  const { GET } = await import("@/app/api/account/handover-decision/route");
  return GET(new NextRequest("http://localhost/api/account/handover-decision"));
}

async function decide(
  decisions: { grantId: string; access: HandoverAccess }[],
) {
  const { POST } = await import("@/app/api/account/handover-decision/route");
  return POST(
    new NextRequest(
      "http://localhost/api/account/handover-decision",
      json(handoverDecisionBody(decisions)),
    ),
  );
}

async function auditActions(userId: string): Promise<string[]> {
  const rows = await getPrismaClient().auditLog.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { action: true },
  });
  return rows.map((r) => r.action);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  sent.length = 0;
});

afterEach(async () => {
  const prisma = getPrismaClient();
  await prisma.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS handover_claim_failure ON "managed_profile_handovers"',
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION IF EXISTS fail_handover_claim()",
  );
  delete process.env.OIDC_ONLY;
  delete process.env.OIDC_ISSUER_URL;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
});

describe("the handover link", () => {
  it("is shown once and stored only as its hash", async () => {
    const { creator, profile } = await household();
    signIn(creator);

    const response = await mint(profile.id);
    expect(response.status).toBe(201);
    const { data } = await response.json();
    expect(data.token).toMatch(/^hlp_[0-9a-f]{64}$/);
    expect(data.url).toMatch(new RegExp(`/claim/${data.token}$`));

    const row = await getPrismaClient().managedProfileHandover.findFirstOrThrow(
      { where: { profileId: profile.id } },
    );
    expect(row.tokenHash).toBe(hashToken(data.token));
    expect(JSON.stringify(row)).not.toContain(data.token);

    // The status read never returns the link again.
    const read = await (await status(profile.id)).json();
    expect(read.data.open).toMatchObject({ createdByYou: true });
    expect(JSON.stringify(read)).not.toContain(data.token);

    // Nothing written to the audit trail carries it either.
    const audit = await getPrismaClient().auditLog.findMany();
    expect(JSON.stringify(audit)).not.toContain(data.token);
  });

  it("keeps at most one link open per profile", async () => {
    const { creator, second, profile } = await household();
    signIn(creator);
    const first = await mintToken(profile.id);
    signIn(second);
    const replacement = await mintToken(profile.id);

    const open = await getPrismaClient().managedProfileHandover.count({
      where: { profileId: profile.id, usedAt: null, revokedAt: null },
    });
    expect(open).toBe(1);

    signOut();
    expect((await preview(first)).status).toBe(404);
    expect((await preview(replacement)).status).toBe(200);
  });

  it("dies when a Guardian withdraws it", async () => {
    const { creator, profile } = await household();
    signIn(creator);
    const token = await mintToken(profile.id);
    expect((await withdraw(profile.id)).status).toBe(200);

    signOut();
    expect((await preview(token)).status).toBe(404);
    expect((await claim(token)).status).toBe(404);
    expect(await auditActions(profile.id)).toContain(
      "managed_profile.handover.revoked",
    );
  });

  it("dies when it expires", async () => {
    const { creator, profile } = await household();
    signIn(creator);
    const token = await mintToken(profile.id);
    await getPrismaClient().managedProfileHandover.updateMany({
      where: { profileId: profile.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    signOut();
    expect((await preview(token)).status).toBe(404);
    expect((await claim(token)).status).toBe(404);
  });

  it("dies with its creator's access", async () => {
    const { creator, second, profile, creatorGrant } = await household();
    signIn(creator);
    const token = await mintToken(profile.id);

    await revokeManagedProfileGuardian({
      profileId: profile.id,
      guardianId: second.id,
      grantId: creatorGrant.id,
    });

    signIn(second);
    const read = await (await status(profile.id)).json();
    expect(read.data.open).toBeNull();
    signOut();
    expect((await preview(token)).status).toBe(404);
  });

  it("is single use", async () => {
    const { creator, profile } = await household();
    signIn(creator);
    const token = await mintToken(profile.id);

    signOut();
    expect((await claim(token)).status).toBe(201);
    signOut();
    expect((await claim(token)).status).toBe(404);
    expect((await preview(token)).status).toBe(404);
  });

  it("answers one 404 for every unusable token", async () => {
    for (const token of [
      "hlp_" + "0".repeat(64),
      "not-a-token",
      "hlv_" + "a".repeat(64),
    ]) {
      const response = await preview(token);
      expect(response.status).toBe(404);
      expect((await response.json()).meta.errorCode).toBe(
        "profile_claim.invalid",
      );
    }
  });
});

describe("minting the link", () => {
  it("needs a fresh second factor", async () => {
    const creator = await person("stale", false);
    const { profile } = await createManagedProfile({
      creatorId: creator.id,
      displayName: "Robin",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    signIn(creator);
    const response = await mint(profile.id);
    expect(response.status).toBe(401);
    expect((await response.json()).meta.errorCode).toBe("auth.stepup.required");
  });

  it("is unreachable with a Bearer token, even a wildcard one", async () => {
    const { creator, profile } = await household();
    const raw = `hlk_${"c".repeat(64)}`;
    await getPrismaClient().apiToken.create({
      data: {
        userId: creator.id,
        name: "handover-test",
        tokenHash: hashToken(raw),
        permissions: ["*"],
      },
    });
    signOut();
    headerJar.set("authorization", `Bearer ${raw}`);
    expect((await mint(profile.id)).status).toBe(401);
    expect((await status(profile.id)).status).toBe(401);
    expect((await withdraw(profile.id)).status).toBe(401);
  });

  it("answers 404 to somebody who is not a Guardian", async () => {
    const { profile } = await household();
    const stranger = await person("stranger");
    signIn(stranger);
    expect((await mint(profile.id)).status).toBe(404);
    expect((await status(profile.id)).status).toBe(404);
    expect((await withdraw(profile.id)).status).toBe(404);
  });

  it("refuses a proposal for somebody who is not a Guardian", async () => {
    const { creator, profile } = await household();
    signIn(creator);
    const response = await mint(profile.id, [
      { grantId: "not-a-guardian", proposal: "manage" },
    ]);
    expect(response.status).toBe(422);
    expect((await response.json()).meta.errorCode).toBe(
      "managed_profile.handover.unknown_guardian",
    );
  });
});

describe("claiming the profile", () => {
  it("turns the profile into the person's own account, in one go", async () => {
    const { creator, second, profile, creatorGrant, secondGrant } =
      await household();
    const prisma = getPrismaClient();
    // The record's data, which must not move.
    await prisma.measurement.create({
      data: {
        userId: profile.id,
        type: "WEIGHT",
        value: 41,
        unit: "kg",
        measuredAt: new Date(),
        source: "MANUAL",
      },
    });
    // A disclaimer and an AI consent a Guardian gave on the person's behalf.
    await prisma.user.update({
      where: { id: profile.id },
      data: {
        disclaimerAcknowledgedAt: new Date(),
        disclaimerAcknowledgedVersion: "1",
        onboardingCompletedAt: new Date(),
      },
    });
    await prisma.consentReceipt.create({
      data: {
        userId: profile.id,
        kind: "ai_full",
        artefact: "{}",
        signedAt: new Date(),
      },
    });
    // The second Guardian is inside the record right now.
    await prisma.session.update({
      where: { id: second.sessionId },
      data: { actingAsUserId: profile.id },
    });
    // A Guardian invitation nobody accepted yet.
    const third = await person("third");
    const pending = await inviteGrant({
      grantorId: profile.id,
      granteeId: third.id,
      access: "MANAGE",
      scope: null,
    });

    signIn(creator);
    const token = await mintToken(profile.id, [
      { grantId: creatorGrant.id, proposal: "manage" },
      { grantId: secondGrant.id, proposal: "end" },
    ]);
    signOut();

    const response = await claim(token, { username: "robin" });
    expect(response.status).toBe(201);
    expect((await response.json()).data).toEqual({
      userId: profile.id,
      username: "robin",
    });
    // A session for the new owner, with setup owed.
    expect(cookieJar.get("healthlog_session")).toBeTruthy();
    expect(cookieJar.get("hl_onboarding")).toBe("pending");

    const account = await prisma.user.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(account.managedProfileAt).toBeNull();
    expect(account.username).toBe("robin");
    expect(account.email).toMatch(/@example\.test$/);
    expect(await verifyPassword(account.passwordHash ?? "", PASSWORD)).toBe(
      true,
    );
    expect(account.disclaimerAcknowledgedAt).toBeNull();
    expect(account.disclaimerAcknowledgedVersion).toBeNull();
    expect(account.onboardingCompletedAt).toBeNull();

    // No data moved.
    expect(
      await prisma.measurement.count({ where: { userId: profile.id } }),
    ).toBe(1);

    // The creator keeps MANAGE on the very same row; the second Guardian's
    // row ended, ended by the record's owner, and their browser left it.
    const kept = await prisma.accountGrant.findUniqueOrThrow({
      where: { id: creatorGrant.id },
    });
    expect(kept.revokedAt).toBeNull();
    const ended = await prisma.accountGrant.findUniqueOrThrow({
      where: { id: secondGrant.id },
    });
    expect(ended.revokedBy).toBe("GRANTOR");
    expect(
      await prisma.accountGrant.count({
        where: { grantorId: profile.id, granteeId: second.id, revokedAt: null },
      }),
    ).toBe(0);
    const secondSession = await prisma.session.findUniqueOrThrow({
      where: { id: second.sessionId },
    });
    expect(secondSession.actingAsUserId).toBeNull();

    // The pending invitation is withdrawn and can no longer be accepted.
    const withdrawn = await prisma.accountGrant.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(withdrawn.revokedAt).not.toBeNull();
    await expect(
      acceptGrant({ grantId: pending.id, granteeId: third.id }),
    ).rejects.toBeInstanceOf(GrantError);

    // The consent a Guardian gave is withdrawn; the person gives their own.
    expect(
      await prisma.consentReceipt.count({
        where: { userId: profile.id, revokedAt: null },
      }),
    ).toBe(0);

    // Reminders no longer fan out to the Guardians.
    expect(
      await resolveManagedGuardianRecipientIds({
        userId: profile.id,
        eventType: "MEDICATION_REMINDER",
        title: "t",
        message: "m",
      } as Parameters<typeof resolveManagedGuardianRecipientIds>[0]),
    ).toBeNull();

    // Every step is on the record's trail and on each Guardian's own.
    const recordTrail = await auditActions(profile.id);
    expect(recordTrail).toEqual(
      expect.arrayContaining([
        "managed_profile.handover.created",
        "managed_profile.claimed",
        "auth.claim",
      ]),
    );
    expect(await auditActions(creator.id)).toContain(
      "managed_profile.handed_over",
    );
    expect(await auditActions(second.id)).toContain(
      "managed_profile.handed_over",
    );

    // Each Guardian is told, on their own channels, what their access became.
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual(
      expect.arrayContaining([
        {
          userId: creator.id,
          titleKey: "notifications.handover.claimedTitle",
          messageKey: "notifications.handover.claimedManage",
        },
        {
          userId: second.id,
          titleKey: "notifications.handover.claimedTitle",
          messageKey: "notifications.handover.claimedEnd",
        },
      ]),
    );
  });

  it("cuts a Guardian proposed view-only to a new READ row", async () => {
    const { creator, second, profile, secondGrant } = await household();
    signIn(creator);
    const token = await mintToken(profile.id, [
      { grantId: secondGrant.id, proposal: "read" },
    ]);
    signOut();
    expect((await claim(token)).status).toBe(201);

    const live = await getPrismaClient().accountGrant.findFirstOrThrow({
      where: { grantorId: profile.id, granteeId: second.id, revokedAt: null },
    });
    expect(live.id).not.toBe(secondGrant.id);
    expect(live.access).toBe("READ");
    expect(live.acceptedAt).not.toBeNull();
    expect(live.scopeJson).toBeNull();
    // The creator, left out of the proposals, is proposed READ too.
    const creatorLive = await getPrismaClient().accountGrant.findFirstOrThrow({
      where: { grantorId: profile.id, granteeId: creator.id, revokedAt: null },
    });
    expect(creatorLive.access).toBe("READ");
  });

  it("leaves the profile untouched when the transaction fails part-way", async () => {
    const { creator, profile, secondGrant } = await household();
    const prisma = getPrismaClient();
    const third = await person("third");
    const pending = await inviteGrant({
      grantorId: profile.id,
      granteeId: third.id,
      access: "MANAGE",
      scope: null,
    });
    signIn(creator);
    const token = await mintToken(profile.id, [
      { grantId: secondGrant.id, proposal: "end" },
    ]);
    signOut();

    // Fail the claim's LAST write: everything before it has run by then.
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION fail_handover_claim() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected handover failure';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER handover_claim_failure
      BEFORE UPDATE ON "managed_profile_handovers"
      FOR EACH ROW
      WHEN (NEW.proposals_json IS DISTINCT FROM OLD.proposals_json)
      EXECUTE FUNCTION fail_handover_claim();
    `);

    // The route's error boundary turns the thrown transaction into a 500.
    expect((await claim(token)).status).toBe(500);

    const account = await prisma.user.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(account.managedProfileAt).not.toBeNull();
    expect(account.username.startsWith("managed-")).toBe(true);
    expect(account.passwordHash).toBeNull();
    expect(account.email).toBeNull();
    const row = await prisma.managedProfileHandover.findFirstOrThrow({
      where: { profileId: profile.id },
    });
    expect(row.usedAt).toBeNull();
    expect(
      (
        await prisma.accountGrant.findUniqueOrThrow({
          where: { id: secondGrant.id },
        })
      ).revokedAt,
    ).toBeNull();
    expect(
      (
        await prisma.accountGrant.findUniqueOrThrow({
          where: { id: pending.id },
        })
      ).revokedAt,
    ).toBeNull();
    expect(await auditActions(profile.id)).not.toContain(
      "managed_profile.claimed",
    );
    expect(cookieJar.get("healthlog_session")).toBeUndefined();

    // With the fault gone, the same link still works.
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER handover_claim_failure ON "managed_profile_handovers"',
    );
    expect((await claim(token)).status).toBe(201);
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const { creator, profile } = await household();
    signIn(creator);
    const token = await mintToken(profile.id);
    signOut();

    const statuses = (await Promise.all([claim(token), claim(token)])).map(
      (r) => r.status,
    );
    expect(statuses.sort()).toEqual([201, 404]);
  });

  it("orders a claim against a new link: the replaced link is dead", async () => {
    const { creator, profile } = await household();
    signIn(creator);
    const first = await mintToken(profile.id);
    signOut();

    // Through the service, not the routes: the two would otherwise share one
    // cookie jar, and the race is between the two transactions, not cookies.
    const [claimed, minted] = await Promise.allSettled([
      claimManagedProfile({
        rawToken: first,
        username: "racer",
        email: "racer@example.test",
        passwordHash: "hash",
      }),
      createHandover({
        profileId: profile.id,
        guardianId: creator.id,
        expiresInDays: 7,
        proposals: [],
      }),
    ]);
    // Either the claim went first (and the mint finds no managed profile), or
    // the mint went first (and the claim finds a withdrawn link).
    expect(
      (claimed.status === "fulfilled" && minted.status === "rejected") ||
        (claimed.status === "rejected" && minted.status === "fulfilled"),
    ).toBe(true);
    const account = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(account.managedProfileAt === null).toBe(
      claimed.status === "fulfilled",
    );
  });

  it("orders a claim against the profile's deletion", async () => {
    const { creator, profile } = await household();
    signIn(creator);
    const token = await mintToken(profile.id);
    signOut();

    const [claimed, deleted] = await Promise.allSettled([
      claim(token),
      deleteManagedProfile({ profileId: profile.id, guardianId: creator.id }),
    ]);
    const account = await getPrismaClient().user.findUnique({
      where: { id: profile.id },
    });
    if (account) {
      // The claim won: the account stands, unmanaged, and the deletion was
      // refused because there was no managed profile left to delete.
      expect(claimed.status === "fulfilled" && claimed.value.status).toBe(201);
      expect(account.managedProfileAt).toBeNull();
      expect(deleted.status).toBe("rejected");
    } else {
      // The deletion won: the link went with the profile.
      expect(claimed.status === "fulfilled" && claimed.value.status).toBe(404);
    }
  });

  it("refuses over a live session and on a single-sign-on-only instance", async () => {
    const { creator, profile } = await household();
    signIn(creator);
    const token = await mintToken(profile.id);

    const overSession = await claim(token);
    expect(overSession.status).toBe(409);
    expect((await overSession.json()).meta.errorCode).toBe(
      "auth.already_authenticated",
    );

    process.env.OIDC_ISSUER_URL = "https://idp.example.test";
    process.env.OIDC_CLIENT_ID = "client";
    process.env.OIDC_CLIENT_SECRET = "secret";
    process.env.OIDC_ONLY = "true";
    expect((await mint(profile.id)).status).toBe(403);
    const status = await (
      await (
        await import("@/app/api/managed-profiles/[id]/handover/route")
      ).GET(
        new NextRequest(
          `http://localhost/api/managed-profiles/${profile.id}/handover`,
        ),
        { params: Promise.resolve({ id: profile.id }) },
      )
    ).json();
    expect(status.data.available).toBe(false);
    signOut();
    for (const response of [await preview(token), await claim(token)]) {
      expect(response.status).toBe(403);
      expect((await response.json()).meta.errorCode).toBe(
        "profile_claim.oidc_only_unsupported",
      );
    }
    // The profile is still managed: nothing was taken over.
    const account = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(account.managedProfileAt).not.toBeNull();
  });

  it("rate-limits claim attempts per address", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await claim(`hlp_${String(i).repeat(64)}`)).status);
    }
    expect(codes.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(codes[5]).toBe(429);
  });

  it("refuses a username that is already taken, before using the link", async () => {
    const { creator, profile } = await household();
    signIn(creator);
    const token = await mintToken(profile.id);
    signOut();

    const response = await claim(token, { username: creator.username });
    expect(response.status).toBe(409);
    expect((await response.json()).meta.errorCode).toBe("profile_claim.taken");
    // The link survives a refused attempt.
    expect((await preview(token)).status).toBe(200);
  });
});

describe("the new owner's decision", () => {
  async function claimedHousehold(
    proposals: (h: Awaited<ReturnType<typeof household>>) => {
      grantId: string;
      proposal: HandoverAccess;
    }[],
  ) {
    const h = await household();
    signIn(h.creator);
    const token = await mintToken(h.profile.id, proposals(h));
    signOut();
    const response = await claim(token);
    expect(response.status).toBe(201);
    sent.length = 0;
    return h;
  }

  it("shows each Guardian's access and applies the owner's final word", async () => {
    const h = await claimedHousehold((x) => [
      { grantId: x.creatorGrant.id, proposal: "manage" },
      { grantId: x.secondGrant.id, proposal: "end" },
    ]);

    const before = await (await readDecision()).json();
    expect(before.data.pending.guardians).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grantId: h.creatorGrant.id,
          proposal: "manage",
          current: "manage",
          decidable: true,
        }),
        expect.objectContaining({
          grantId: h.secondGrant.id,
          proposal: "end",
          current: "end",
          decidable: true,
        }),
      ]),
    );

    const response = await decide([
      { grantId: h.creatorGrant.id, access: "end" },
      { grantId: h.secondGrant.id, access: "manage" },
    ]);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ decided: true, changed: 2 });

    const prisma = getPrismaClient();
    expect(
      await prisma.accountGrant.count({
        where: {
          grantorId: h.profile.id,
          granteeId: h.creator.id,
          revokedAt: null,
        },
      }),
    ).toBe(0);
    const restored = await prisma.accountGrant.findFirstOrThrow({
      where: {
        grantorId: h.profile.id,
        granteeId: h.second.id,
        revokedAt: null,
      },
    });
    expect(restored.access).toBe("MANAGE");
    expect(restored.acceptedAt).not.toBeNull();

    expect((await (await readDecision()).json()).data.pending).toBeNull();
    const again = await decide([]);
    expect(again.status).toBe(409);
    expect((await again.json()).meta.errorCode).toBe(
      "managed_profile.handover.no_pending",
    );

    expect(await auditActions(h.profile.id)).toContain(
      "managed_profile.handover.decided",
    );
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.messageKey).sort()).toEqual([
      "notifications.handover.changedEnd",
      "notifications.handover.changedManage",
    ]);
  });

  it("leaves alone a Guardian whose access moved since the claim", async () => {
    const h = await claimedHousehold((x) => [
      { grantId: x.secondGrant.id, proposal: "read" },
    ]);
    const prisma = getPrismaClient();
    const readRow = await prisma.accountGrant.findFirstOrThrow({
      where: {
        grantorId: h.profile.id,
        granteeId: h.second.id,
        revokedAt: null,
      },
    });
    // The Guardian steps away on their own.
    await renounceGrantAndClearSwitch({
      grantId: readRow.id,
      granteeId: h.second.id,
    });

    const before = await (await readDecision()).json();
    const row = before.data.pending.guardians.find(
      (g: { grantId: string }) => g.grantId === h.secondGrant.id,
    );
    expect(row).toMatchObject({ decidable: false, current: "end" });

    expect(
      (await decide([{ grantId: h.secondGrant.id, access: "manage" }])).status,
    ).toBe(200);
    // Their choice to leave stands.
    expect(
      await prisma.accountGrant.count({
        where: {
          grantorId: h.profile.id,
          granteeId: h.second.id,
          revokedAt: null,
        },
      }),
    ).toBe(0);
  });

  it("refuses a decision about somebody who was not a Guardian", async () => {
    await claimedHousehold(() => []);
    const response = await decide([{ grantId: "stranger", access: "manage" }]);
    expect(response.status).toBe(422);
  });

  it("answers no pending decision to an account that never was a profile", async () => {
    const someone = await person("someone");
    signIn(someone);
    expect((await (await readDecision()).json()).data.pending).toBeNull();
  });
});
