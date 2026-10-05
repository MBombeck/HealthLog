/**
 * The front door, driven as routes, against real Postgres.
 *
 * `/` is the first page a delegate lands on after switching, and until this
 * release ten of the reads it issues refused there with `undeclared_mode`.
 * Admitting them is the easy half; the half that can go quietly wrong is the
 * one this file exists for. A route that stops refusing and answers with the
 * CALLER's own rows is worse than the refusal it replaced, because a 403 is
 * visible and a plausible wrong number is not — and this exact page has
 * already shipped that bug once, when the RSC prefetch seeded the delegate's
 * dashboard under the owner's banner.
 *
 * So no case here asserts a status code and stops. Each one seeds the owner
 * AND the delegate with different values, reads the route as each of them
 * WITHOUT a switch to learn what each answer looks like, asserts the two
 * differ — that assertion is the evidence, without it a route returning
 * nothing at all would satisfy every line below — and only then switches in
 * and demands the owner's answer back, byte for byte, and not the delegate's.
 *
 * The actor surfaces are asserted the other way round, because for them the
 * caller's own answer is the correct one: the locale setter has to write the
 * DELEGATE's row and leave the owner's alone, which is a claim about two rows
 * and is checked against both.
 *
 * Everything runs through the shipped exports — the real `apiHandler`, the
 * real resolvers, the real grant table. The substitution happens above the
 * handler body, so a test that rebuilt a handler would be exercising its own
 * copy of it and would keep passing after the route stopped performing it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables, switchSessionTo } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `front-${suffix}`,
      email: `front-${suffix}@example.test`,
      displayName: `Front ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

/**
 * A live grant at the named level with the delegate's session already inside
 * the owner's record — minted through the shipped transitions, so a release
 * that could no longer create the grant fails here rather than passing against
 * a row this file wrote itself.
 */
async function switchInto(
  ownerId: string,
  delegateId: string,
  access: "READ" | "WRITE" = "READ",
) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: ownerId,
    granteeId: delegateId,
    access,
    scope: null,
  });
  const grant = await acceptGrant({
    grantId: invited.id,
    granteeId: delegateId,
  });
  const session = await signIn(delegateId);
  await switchSessionTo(session.id, ownerId);
  return { grant, session };
}

async function revoke(grantId: string, ownerId: string) {
  const { revokeGrant } = await import("@/lib/sharing/grants");
  await revokeGrant({ grantId, grantorId: ownerId });
}

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

function request(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

async function drive(
  handler: Handler,
  url: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  return handler(request(url, method, body), {
    params: Promise.resolve({}),
  });
}

async function envelope(response: Response): Promise<{
  data: unknown;
  error: unknown;
  meta?: { errorCode?: string };
}> {
  return response.json();
}

/** No grant, or a grant that is gone. */
async function expectAccessDenied(response: Response) {
  expect(response.status).toBe(403);
  expect((await envelope(response)).meta?.errorCode).toBe(
    "sharing.access.denied",
  );
}

/** The route never declared it can be used under a switch. */
async function expectNotPermitted(response: Response) {
  expect(response.status).toBe(403);
  expect((await envelope(response)).meta?.errorCode).toBe(
    "sharing.not_permitted",
  );
}

async function ok(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  return (await envelope(response)).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

/* -------------------------------------------------------------------------- */
/* The shape of a front-door read                                             */
/* -------------------------------------------------------------------------- */

interface FrontDoorRead {
  /** Seed one account so its answer is recognisable. */
  seed: (userId: string, marker: string) => Promise<void>;
  /** Call the shipped GET export against whatever session is current. */
  call: () => Promise<Response>;
  /** The part of the payload that identifies whose record answered. */
  read: (data: never) => unknown;
}

function frontDoorRead(name: string, route: FrontDoorRead) {
  describe(name, () => {
    it("answers with the owner's record, not the caller's own", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      await route.seed(owner.id, "owner");
      await route.seed(delegate.id, "delegate");

      // What each account's own answer looks like, read the ordinary way.
      // This is also the "unchanged for a caller who never switched" case:
      // both calls run with no carrier at all.
      await signIn(owner.id);
      const ownerAnswer = route.read((await ok(await route.call())) as never);
      await signIn(delegate.id);
      const delegateAnswer = route.read(
        (await ok(await route.call())) as never,
      );

      // The evidence. Without it every assertion below is satisfied by a
      // route that answers the same thing to everybody — including nothing.
      expect(ownerAnswer).not.toEqual(delegateAnswer);

      await switchInto(owner.id, delegate.id);
      const switched = route.read((await ok(await route.call())) as never);

      expect(switched).toEqual(ownerAnswer);
      expect(switched).not.toEqual(delegateAnswer);
    });

    it("refuses the next request after the grant is revoked", async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      await route.seed(owner.id, "owner");

      const { grant } = await switchInto(owner.id, delegate.id);
      expect((await route.call()).status).toBe(200);

      // Same browser, same session, next request.
      await revoke(grant.id, owner.id);
      await expectAccessDenied(await route.call());
    });

    it("refuses a caller who names a record they were never granted", async () => {
      const owner = await makeUser("owner");
      const stranger = await makeUser("stranger");
      await route.seed(owner.id, "owner");

      const session = await signIn(stranger.id);
      await switchSessionTo(session.id, owner.id);

      await expectAccessDenied(await route.call());
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The aggregates                                                             */
/* -------------------------------------------------------------------------- */

frontDoorRead("GET /api/dashboard/snapshot", {
  // The snapshot names the account it was built for, which makes the marker
  // the account itself rather than a value that happens to differ.
  seed: async () => {},
  call: async () => {
    const { GET } = await import("@/app/api/dashboard/snapshot/route");
    return drive(GET as Handler, "/api/dashboard/snapshot");
  },
  read: (data: { user: { username: string } }) => data.user.username,
});

/** The person's own provider (presence only) and an AI consent receipt. */
function ownProvider() {
  return {
    aiProvider: "ANTHROPIC",
    aiAnthropicKeyEncrypted: "v1:presence-only",
    consentReceipts: {
      create: { kind: "ai_full", artefact: "test", signedAt: new Date() },
    },
  };
}

/** A parseable cached briefing — the only thing the digest lifts prose from. */
function cachedBriefing(marker: string): string {
  return JSON.stringify({
    dailyBriefing: {
      paragraph: `Briefing for the ${marker}. Second sentence.`,
      keyFindings: [],
    },
    // Generated now: only text written today is served as today's read.
    briefingGeneratedAt: new Date().toISOString(),
  });
}

frontDoorRead("GET /api/daily/digest", {
  // The briefing lead is stored model text: shown whenever the record's own
  // `briefing` capability allows it, whoever reads. Each account therefore
  // has its own provider (presence only) and consent.
  seed: async (userId, marker) => {
    await getPrismaClient().user.update({
      where: { id: userId },
      data: {
        insightsCachedText: cachedBriefing(marker),
        insightsCachedAt: new Date(),
        ...ownProvider(),
      },
    });
  },
  call: async () => {
    const { GET } = await import("@/app/api/daily/digest/route");
    return drive(GET as Handler, "/api/daily/digest");
  },
  read: (data: { briefingLead: string | null }) => data.briefingLead,
});

frontDoorRead("GET /api/gamification/achievements", {
  // Badges are earned from the record's own history, so the marker is the
  // history: the owner has logged readings and the delegate has not. Dates are
  // relative to now — a fixed date slides out of the trailing windows the
  // badge engine counts over and takes the difference with it.
  seed: async (userId, marker) => {
    if (marker !== "owner") return;
    const prisma = getPrismaClient();
    for (let back = 0; back < 6; back++) {
      await prisma.measurement.create({
        data: {
          userId,
          type: "WEIGHT",
          value: 80 + back,
          unit: "kg",
          measuredAt: new Date(Date.now() - back * 24 * 60 * 60 * 1000),
          source: "MANUAL",
        },
      });
    }
  },
  call: async () => {
    const { GET } = await import("@/app/api/gamification/achievements/route");
    return drive(GET as Handler, "/api/gamification/achievements");
  },
  // Per-badge progress rather than the headline tally: six readings move
  // several counters without necessarily unlocking anything, and a summary
  // that reads 0/0 for both accounts would make the comparison vacuous.
  read: (data: { achievements: { id: string; current: number }[] }) =>
    data.achievements.map((a) => `${a.id}:${a.current}`).join("|"),
});

/* -------------------------------------------------------------------------- */
/* The Coach reads                                                            */
/* -------------------------------------------------------------------------- */

async function seedAssistantMessage(userId: string, at: string) {
  const prisma = getPrismaClient();
  const { encryptToBytes } = await import("@/lib/ai/coach/bytes-codec");
  const conversation = await prisma.coachConversation.create({
    data: { userId, title: "Nudge" },
  });
  await prisma.coachMessage.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      encryptedContent: encryptToBytes("A proactive line."),
      createdAt: new Date(at),
    },
  });
}

frontDoorRead("GET /api/insights/coach/nudge-status", {
  seed: async (userId, marker) => {
    await getPrismaClient().user.update({
      where: { id: userId },
      data: ownProvider(),
    });
    await seedAssistantMessage(
      userId,
      marker === "owner" ? "2026-07-01T09:00:00Z" : "2026-07-02T09:00:00Z",
    );
  },
  call: async () => {
    const { GET } = await import("@/app/api/insights/coach/nudge-status/route");
    return drive(GET as Handler, "/api/insights/coach/nudge-status");
  },
  read: (data: { nudgedAt: string | null }) => data.nudgedAt,
});

frontDoorRead("GET /api/coach/reminders", {
  // The note is encrypted at rest, so the marker only appears in the response
  // if the route read the right rows AND decrypted them.
  seed: async (userId, marker) => {
    const { encryptToBytes } = await import("@/lib/ai/coach/bytes-codec");
    await getPrismaClient().coachReminder.create({
      data: {
        userId,
        noteEncrypted: encryptToBytes(`Remind the ${marker} about this.`),
        triggerKind: "date",
        status: "active",
        source: "manual",
      },
    });
  },
  call: async () => {
    const { GET } = await import("@/app/api/coach/reminders/route");
    return drive(GET as Handler, "/api/coach/reminders");
  },
  read: (data: { reminders: { note: string }[] }) =>
    data.reminders.map((r) => r.note),
});

/* -------------------------------------------------------------------------- */
/* The presentation trio — read admitted, write refused                       */
/* -------------------------------------------------------------------------- */

frontDoorRead("GET /api/settings/reminder-thresholds", {
  seed: async (userId, marker) => {
    await getPrismaClient().user.update({
      where: { id: userId },
      data: {
        notificationPrefs: {
          medication: { lowStockRunwayDays: marker === "owner" ? 21 : 3 },
        },
      },
    });
  },
  call: async () => {
    const { GET } =
      await import("@/app/api/settings/reminder-thresholds/route");
    return drive(GET as Handler, "/api/settings/reminder-thresholds");
  },
  read: (data: { lowStockRunwayDays: number | null }) =>
    data.lowStockRunwayDays,
});

async function seedDashboardLayout(userId: string, marker: string) {
  const { serializeDashboardLayout, DEFAULT_DASHBOARD_LAYOUT } =
    await import("@/lib/dashboard-layout");
  const layout = serializeDashboardLayout({
    ...DEFAULT_DASHBOARD_LAYOUT,
    comparisonBaseline: marker === "owner" ? "lastYear" : "lastMonth",
  });
  await getPrismaClient().user.update({
    where: { id: userId },
    // The blob is a plain JSON column; the serializer above produced the shape
    // the resolver reads back.
    data: { dashboardWidgetsJson: layout as never },
  });
}

frontDoorRead("GET /api/dashboard/widgets", {
  seed: seedDashboardLayout,
  call: async () => {
    const { GET } = await import("@/app/api/dashboard/widgets/route");
    return drive(GET as Handler, "/api/dashboard/widgets");
  },
  read: (data: { comparisonBaseline: string }) => data.comparisonBaseline,
});

async function seedMedicationLayout(userId: string, marker: string) {
  const { serializeMedicationListLayout } =
    await import("@/lib/medication-list-layout");
  const layout = serializeMedicationListLayout({
    view: marker === "owner" ? "table" : "cards",
    order: [`${marker}-med-id`],
  });
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { medicationListLayoutJson: layout as never },
  });
}

frontDoorRead("GET /api/medications/layout", {
  seed: seedMedicationLayout,
  call: async () => {
    const { GET } = await import("@/app/api/medications/layout/route");
    return drive(GET as Handler, "/api/medications/layout");
  },
  read: (data: { view: string; order: string[] }) =>
    `${data.view}:${data.order.join(",")}`,
});

/* -------------------------------------------------------------------------- */
/* The write arms the split leaves refusing                                   */
/* -------------------------------------------------------------------------- */

describe("a delegate cannot rewrite the record's presentation", () => {
  it("refuses PUT /api/dashboard/widgets under a WRITE grant and changes nothing", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedDashboardLayout(owner.id, "owner");

    // A WRITE grant, the strongest thing a delegate can hold. The read arm
    // above admits this caller; the write arm still must not.
    await switchInto(owner.id, delegate.id, "WRITE");

    const { PUT } = await import("@/app/api/dashboard/widgets/route");
    await expectNotPermitted(
      await drive(PUT as Handler, "/api/dashboard/widgets", "PUT", {
        version: 1,
        comparisonBaseline: "lastMonth",
      }),
    );

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: owner.id },
      select: { dashboardWidgetsJson: true },
    });
    expect(
      (row.dashboardWidgetsJson as { comparisonBaseline?: string })
        ?.comparisonBaseline,
    ).toBe("lastYear");
  });

  it("refuses PUT /api/medications/layout under a WRITE grant and changes nothing", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedMedicationLayout(owner.id, "owner");

    await switchInto(owner.id, delegate.id, "WRITE");

    const { PUT } = await import("@/app/api/medications/layout/route");
    await expectNotPermitted(
      await drive(PUT as Handler, "/api/medications/layout", "PUT", {
        version: 1,
        view: "cards",
      }),
    );

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: owner.id },
      select: { medicationListLayoutJson: true },
    });
    expect((row.medicationListLayoutJson as { view?: string })?.view).toBe(
      "table",
    );
  });

  it("refuses POST /api/coach/reminders under a WRITE grant and writes no row", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");

    await switchInto(owner.id, delegate.id, "WRITE");

    const { POST } = await import("@/app/api/coach/reminders/route");
    await expectNotPermitted(
      await drive(POST as Handler, "/api/coach/reminders", "POST", {
        note: "Put this in somebody else's Coach memory.",
      }),
    );

    expect(await getPrismaClient().coachReminder.count()).toBe(0);
  });

  it("still lets the owner write their own presentation", async () => {
    // The regression guard for the split: the arms above refuse a DELEGATE,
    // and a caller who never switched must not be able to tell any of this
    // happened.
    const plain = await makeUser("plain");
    await seedDashboardLayout(plain.id, "owner");
    await signIn(plain.id);

    const { PUT } = await import("@/app/api/dashboard/widgets/route");
    const response = await drive(
      PUT as Handler,
      "/api/dashboard/widgets",
      "PUT",
      { version: 1, comparisonBaseline: "lastMonth" },
    );
    expect(response.status).toBe(200);

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: plain.id },
      select: { dashboardWidgetsJson: true },
    });
    expect(
      (row.dashboardWidgetsJson as { comparisonBaseline?: string })
        ?.comparisonBaseline,
    ).toBe("lastMonth");
  });
});

/* -------------------------------------------------------------------------- */
/* The actor surfaces                                                         */
/* -------------------------------------------------------------------------- */

describe("PUT /api/auth/me/locale — the language belongs to the person", () => {
  it("writes the delegate's row and leaves the owner's untouched", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: owner.id },
      data: { locale: "en" },
    });

    await switchInto(owner.id, delegate.id, "WRITE");

    const { PUT } = await import("@/app/api/auth/me/locale/route");
    const response = await drive(PUT as Handler, "/api/auth/me/locale", "PUT", {
      locale: "fr",
    });
    expect(response.status).toBe(200);

    // Both rows, because "the delegate's row changed" and "the owner's row
    // did not" are two claims and only the pair rules out a substitution.
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: delegate.id },
          select: { locale: true },
        })
      ).locale,
    ).toBe("fr");
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: owner.id },
          select: { locale: true },
        })
      ).locale,
    ).toBe("en");
  });

  it("refuses a selector header, which an actor surface never has a use for", async () => {
    const caller = await makeUser("caller");
    await signIn(caller.id);
    const { ACCOUNT_SELECTOR_HEADER } =
      await import("@/lib/auth/acting-carrier");
    headerJar.set(ACCOUNT_SELECTOR_HEADER, "some-account-id");

    const { PUT } = await import("@/app/api/auth/me/locale/route");
    await expectNotPermitted(
      await drive(PUT as Handler, "/api/auth/me/locale", "PUT", {
        locale: "fr",
      }),
    );
  });
});

describe("GET /api/feature-flags — the deployment, not the record", () => {
  it("keeps answering while a switch is on", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await switchInto(owner.id, delegate.id);

    const { GET } = await import("@/app/api/feature-flags/route");
    const data = (await ok(
      await drive(GET as Handler, "/api/feature-flags"),
    )) as { assistant: { coach: boolean } };
    // Not a bare 200: the shell gates the Coach launcher on this field, so an
    // empty envelope would satisfy a status-only assertion and still break the
    // surface this route exists to keep alive.
    expect(data.assistant.coach).toBe(true);
  });

  it("refuses a selector header", async () => {
    const caller = await makeUser("caller");
    await signIn(caller.id);
    const { ACCOUNT_SELECTOR_HEADER } =
      await import("@/lib/auth/acting-carrier");
    headerJar.set(ACCOUNT_SELECTOR_HEADER, "some-account-id");

    const { GET } = await import("@/app/api/feature-flags/route");
    await expectNotPermitted(await drive(GET as Handler, "/api/feature-flags"));
  });
});
