/**
 * 1.49 — the setup flow's new steps against real Postgres.
 *
 *   * "Region & units" writes the time zone and the medicine registry to the
 *     account's own columns in the answer's transaction, with the audit rows of
 *     their settings routes, and keeps the answer beside them.
 *   * The two follow-ups (`reminders`, `ai`) take no payload and write nothing
 *     but the step; a skip is a skip.
 *   * A ledger a 1.48 server wrote for a finished flow stays finished: the
 *     account payload publishes both follow-ups as passed and the record reads
 *     settled, so nobody is sent back into the flow.
 *   * The checklist's optional rows: presence for one's own record, the
 *     guardian's rows inside a managed profile, and a delegate refused.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

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

import { toJson } from "@/lib/db";
import {
  isOnboardingSettled,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";
import type { ChecklistExtrasDto } from "@/lib/onboarding/checklist-extras";

const db = () => getPrismaClient();
let counter = 0;

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const suffix = `${label}-${counter++}`;
  return db().user.create({
    data: {
      username: `fu-${suffix}`,
      email: `fu-${suffix}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
      ...extra,
    },
  });
}

async function signInAs(userId: string, actingAs: string | null = null) {
  cookieJar.clear();
  headerJar.clear();
  const session = await db().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
  if (actingAs) await switchSessionTo(session.id, actingAs);
  return session;
}

async function patchAnswer(body: unknown): Promise<Response> {
  const { PATCH } = await import("@/app/api/onboarding/answers/route");
  return (PATCH as (r: Request) => Promise<Response>)(
    new Request("http://localhost/api/onboarding/answers", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readMe(): Promise<OnboardingStateDto> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await (GET as (r: Request) => Promise<Response>)(
    new Request("http://localhost/api/auth/me"),
  );
  return ((await res.json()) as { data: { onboarding: OnboardingStateDto } })
    .data.onboarding;
}

async function getExtras(): Promise<Response> {
  const { GET } = await import("@/app/api/onboarding/extras/route");
  return (GET as (r: NextRequest) => Promise<Response>)(
    new NextRequest("http://localhost/api/onboarding/extras"),
  );
}

function statusOf(state: OnboardingStateDto, id: string) {
  return state.steps.find((step) => step.id === id)?.status;
}

beforeEach(async () => {
  await truncateAllTables(db());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Region & units", () => {
  it("writes the zone and the registry to the account, audited, in one answer", async () => {
    const user = await makeUser("region", { medicineRegistry: "DE" });
    await signInAs(user.id);
    await patchAnswer({ step: "who", recordTarget: "me" });
    await patchAnswer({ step: "medication", medication: "yes" });

    const res = await patchAnswer({
      step: "units",
      units: { timezone: "Europe/Warsaw", medicineRegistry: "PL" },
    });
    expect(res.status).toBe(200);
    const state = (
      (await res.json()) as { data: { onboarding: OnboardingStateDto } }
    ).data.onboarding;
    expect(statusOf(state, "units")).toBe("done");
    expect(state.needs.units.timezone).toBe("Europe/Warsaw");
    expect(state.needs.units.medicineRegistry).toBe("PL");

    const row = await db().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { timezone: true, medicineRegistry: true },
    });
    expect(row).toEqual({ timezone: "Europe/Warsaw", medicineRegistry: "PL" });

    const audit = await db().auditLog.findMany({
      where: {
        userId: user.id,
        action: {
          in: ["user.timezone.update", "user.medicine-registry.update"],
        },
      },
      select: { action: true },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      "user.medicine-registry.update",
      "user.timezone.update",
    ]);
  });

  it("refuses a zone that is not an IANA zone and changes nothing", async () => {
    const user = await makeUser("badzone");
    await signInAs(user.id);
    const res = await patchAnswer({
      step: "units",
      units: { timezone: "Mars/Olympus" },
    });
    expect(res.status).toBe(422);
    const row = await db().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { timezone: true },
    });
    expect(row.timezone).toBe("Europe/Berlin");
  });
});

describe("the follow-ups", () => {
  it("records reminders and ai as steps and writes nothing else", async () => {
    const user = await makeUser("follow");
    await signInAs(user.id);
    const before = await db().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { notificationPrefs: true, disableCoach: true },
    });

    const reminders = await patchAnswer({ step: "reminders" });
    expect(reminders.status).toBe(200);
    const ai = await patchAnswer({ step: "ai", status: "skipped" });
    expect(ai.status).toBe(200);

    const record = await db().onboardingRecord.findUniqueOrThrow({
      where: { userId: user.id },
      select: { stepsJson: true },
    });
    const stored = new Map(
      (record.stepsJson as Array<{ id: string; status: string }>).map((s) => [
        s.id,
        s.status,
      ]),
    );
    expect(stored.get("reminders")).toBe("done");
    expect(stored.get("ai")).toBe("skipped");

    const after = await db().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { notificationPrefs: true, disableCoach: true },
    });
    expect(after).toEqual(before);
    const consents = await db().consentReceipt.count({
      where: { userId: user.id },
    });
    expect(consents).toBe(0);
  });

  it("refuses a payload on a follow-up", async () => {
    const user = await makeUser("payload");
    await signInAs(user.id);
    expect((await patchAnswer({ step: "ai", coach: "yes" })).status).toBe(422);
    expect(
      (await patchAnswer({ step: "reminders", snoozeMinutes: 30 })).status,
    ).toBe(422);
  });
});

describe("a ledger written by 1.48", () => {
  it("stays finished: both follow-ups read as passed and nothing reopens", async () => {
    const user = await makeUser("legacy");
    const stamp = new Date("2026-11-01T08:00:00.000Z");
    await db().onboardingRecord.create({
      data: {
        userId: user.id,
        needsJson: toJson({
          recordTarget: "me",
          areas: ["mood"],
          medication: "yes",
          sources: [],
          visit: "no",
          units: { glucoseUnit: null, unitPreference: null },
        }),
        // Exactly the nine ids 1.48 stored.
        stepsJson: toJson(
          [
            ["who", "done"],
            ["areas", "done"],
            ["medication", "done"],
            ["sources", "skipped"],
            ["visit", "done"],
            ["units", "skipped"],
            ["confirm", "done"],
            ["first-result", "skipped"],
            ["done", "done"],
          ].map(([id, status]) => ({ id, status })),
        ),
        modulesDerivedAt: stamp,
        completedAt: stamp,
      },
    });
    await db().user.update({
      where: { id: user.id },
      data: { onboardingCompletedAt: stamp },
    });
    await signInAs(user.id);

    const state = await readMe();
    expect(statusOf(state, "reminders")).toBe("skipped");
    expect(statusOf(state, "ai")).toBe("skipped");
    expect(isOnboardingSettled(state)).toBe(true);
  });

  /**
   * The upgrade itself, end to end on the server: a person who finished the
   * setup on 1.48 (with "Region & units" passed, which 1.49 would now ask for
   * a medication schedule) opens the app after the update. Nothing may send
   * them back into the flow: the account payload clears the first-run hint
   * (even a stale one the browser still holds), the edge lets every page
   * through, and `/onboarding` itself, opened by hand, offers the setup again
   * instead of resuming a step.
   */
  it("is never sent back into the flow after the upgrade", async () => {
    const user = await makeUser("upgrade");
    const stamp = new Date("2026-11-01T08:00:00.000Z");
    await db().onboardingRecord.create({
      data: {
        userId: user.id,
        needsJson: toJson({
          recordTarget: "me",
          areas: ["blood-pressure"],
          medication: "sometimes",
          sources: ["manual"],
          visit: "within-a-month",
          units: { glucoseUnit: null, unitPreference: null },
        }),
        stepsJson: toJson(
          [
            ["who", "done"],
            ["areas", "done"],
            ["medication", "done"],
            ["sources", "done"],
            ["visit", "done"],
            ["units", "skipped"],
            ["confirm", "done"],
            ["first-result", "skipped"],
            ["done", "done"],
          ].map(([id, status]) => ({ id, status })),
        ),
        modulesDerivedAt: stamp,
        completedAt: stamp,
      },
    });
    await db().user.update({
      where: { id: user.id },
      data: { onboardingCompletedAt: stamp },
    });
    const session = await signInAs(user.id);
    cookieJar.set("hl_onboarding", "pending");

    const state = await readMe();
    expect(isOnboardingSettled(state)).toBe(true);
    expect(cookieJar.has("hl_onboarding")).toBe(false);

    const { proxy } = await import("@/proxy");
    for (const path of ["/", "/medications", "/settings/account"]) {
      const response = proxy(
        new NextRequest(`http://localhost${path}`, {
          headers: { cookie: `healthlog_session=${session.id}` },
        }),
      );
      const location = response.headers.get("location");
      expect(location ?? "", `${path} redirected`).not.toContain("/onboarding");
    }

    const { default: OnboardingRootPage } =
      await import("@/app/onboarding/page");
    // `redirect()` throws; a page that renders returns its tree.
    await expect(OnboardingRootPage()).resolves.toBeTruthy();
  });

  it("an account that skipped the setup on 1.48 is not sent into it either", async () => {
    // "Skip for now" stamped the account and left no answers.
    const user = await makeUser("skipped", {
      onboardingCompletedAt: new Date("2026-10-01T08:00:00.000Z"),
    });
    const session = await signInAs(user.id);

    await readMe();
    expect(cookieJar.has("hl_onboarding")).toBe(false);

    const { proxy } = await import("@/proxy");
    const response = proxy(
      new NextRequest("http://localhost/", {
        headers: { cookie: `healthlog_session=${session.id}` },
      }),
    );
    expect(response.headers.get("location") ?? "").not.toContain("/onboarding");
  });
});

describe("GET /api/onboarding/extras", () => {
  it("answers presence for one's own record", async () => {
    const user = await makeUser("extras");
    await db().device.create({
      data: {
        userId: user.id,
        platform: "ios",
        token: `tok-${user.id}`,
        bundleId: "dev.healthlog.app",
      },
    });
    await signInAs(user.id);
    const res = await getExtras();
    expect(res.status).toBe(200);
    const extras = ((await res.json()) as { data: ChecklistExtrasDto }).data;
    expect(Object.values(extras).every((row) => row.applies)).toBe(true);
    expect(extras.iosApp.done).toBe(true);
    expect(extras.emergencyCard.done).toBe(false);
    expect(extras.reportSchedule.done).toBe(false);
  });

  it("keeps only the guardian's rows inside a managed profile", async () => {
    const guardian = await makeUser("guardian");
    const child = await makeUser("child", { managedProfileAt: new Date() });
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: child.id,
      granteeId: guardian.id,
      access: "MANAGE",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: guardian.id });
    await signInAs(guardian.id, child.id);

    const res = await getExtras();
    expect(res.status).toBe(200);
    const extras = ((await res.json()) as { data: ChecklistExtrasDto }).data;
    const applying = Object.entries(extras)
      .filter(([, row]) => row.applies)
      .map(([id]) => id)
      .sort();
    expect(applying).toEqual(["careFeed", "emergencyCard", "reportSchedule"]);
  });

  it("refuses a delegate on an adult's record", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "MANAGE",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    await signInAs(delegate.id, owner.id);
    expect((await getExtras()).status).toBe(403);
  });
});
