/**
 * Every guarded settings document locks on its OWN revision, never on the
 * row it lives in.
 *
 * Until v1.49 the eight settings documents on the account row used
 * `User.updatedAt` as their lock token, so any other write to the row (a
 * registry choice, a profile save, another document) made every other
 * document's token stale; where the GET served its token from the server
 * cache, the following saves answered 409 for up to five minutes.
 *
 * Pinned here, against the real database, the real trigger (migration 0554)
 * and the real routes:
 *   - for each document: read it, write something else on the same row, read
 *     it again (the token has not moved), save with the token: 200;
 *   - the guard still guards: a second save on the first token answers 409;
 *   - a writer that changes a document behind its route (no cache eviction)
 *     moves the token, and the cached GET serves the moved token;
 *   - a write of the same value does not move it;
 *   - the about-me revision moves with its five fields and not with the
 *     emergency profile or the pending questions on the same row.
 *
 * Mutation check: point `guardedUserDocumentUpdate` back at `updatedAt`, or
 * drop a column from the trigger, and the matching case goes red.
 */
import { beforeEach, describe, expect, it } from "vitest";

import * as coachPrefs from "@/app/api/auth/me/coach-prefs/route";
import * as healthScoreConfig from "@/app/api/auth/me/health-score-config/route";
import * as medicineRegistry from "@/app/api/auth/me/medicine-registry/route";
import * as modules from "@/app/api/auth/me/modules/route";
import * as notificationPrefs from "@/app/api/auth/me/notification-prefs/route";
import * as dashboardWidgets from "@/app/api/dashboard/widgets/route";
import * as insightsLayout from "@/app/api/insights/layout/route";
import * as medicationsLayout from "@/app/api/medications/layout/route";
import * as moodTagLayout from "@/app/api/mood/tags/layout/route";
import { caches } from "@/lib/cache/server-cache";

import { callRoute, type HttpMethod } from "../../kit/call-route";
import { makeSession, makeUser } from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const prisma = getPrismaClient();

type Handler = Parameters<typeof callRoute>[0];
type Session = Awaited<ReturnType<typeof makeSession>>;
type Doc = Record<string, unknown> & { updatedAt?: string };

interface Surface {
  name: string;
  route: string;
  read: Handler;
  write: Handler;
  method: HttpMethod;
  /** A valid write body, built from what the read returned. */
  body: (read: Doc, step: number) => Record<string, unknown>;
  errorCode: string;
}

function withoutToken(doc: Doc): Record<string, unknown> {
  const { updatedAt: _token, unavailableWidgetIds: _derived, ...rest } = doc;
  return rest;
}

const SURFACES: Surface[] = [
  {
    name: "medications layout",
    route: "/api/medications/layout",
    read: medicationsLayout.GET,
    write: medicationsLayout.PUT,
    method: "PUT",
    body: (_read, step) => ({
      version: 1,
      groupBy: step % 2 === 0 ? "category" : "none",
    }),
    errorCode: "medication_layout_conflict",
  },
  {
    name: "insights layout",
    route: "/api/insights/layout",
    read: insightsLayout.GET,
    write: insightsLayout.PUT,
    method: "PUT",
    body: (read, step) => {
      const tiles = (read.tiles as Array<Record<string, unknown>>).map(
        (tile, index) =>
          index === 0 ? { ...tile, visible: step % 2 !== 0 } : tile,
      );
      return { ...withoutToken(read), tiles };
    },
    errorCode: "insights_layout_conflict",
  },
  {
    name: "dashboard widgets",
    route: "/api/dashboard/widgets",
    read: dashboardWidgets.GET,
    write: dashboardWidgets.PUT,
    method: "PUT",
    body: (read, step) => ({
      ...withoutToken(read),
      todayCardVisible: step % 2 !== 0,
    }),
    errorCode: "dashboard_layout_conflict",
  },
  {
    name: "mood-tag layout",
    route: "/api/mood/tags/layout",
    read: moodTagLayout.GET,
    write: moodTagLayout.PUT,
    method: "PUT",
    body: (_read, step) => ({ groupOrder: [step % 2 === 0 ? "a" : "b"] }),
    errorCode: "mood_tag_layout_conflict",
  },
  {
    name: "modules",
    route: "/api/auth/me/modules",
    read: modules.GET,
    write: modules.PATCH,
    method: "PATCH",
    body: (_read, step) => ({ mood: step % 2 !== 0 }),
    errorCode: "modules_conflict",
  },
  {
    name: "notification prefs",
    route: "/api/auth/me/notification-prefs",
    read: notificationPrefs.GET,
    write: notificationPrefs.PATCH,
    method: "PATCH",
    body: (_read, step) => ({ medication: { clientManaged: step % 2 === 0 } }),
    errorCode: "notification_prefs_conflict",
  },
  {
    name: "coach prefs",
    route: "/api/auth/me/coach-prefs",
    read: coachPrefs.GET,
    write: coachPrefs.PUT,
    method: "PUT",
    body: (_read, step) => ({
      excludeMetrics: [step % 2 === 0 ? "weight" : "mood"],
    }),
    errorCode: "coach_prefs_conflict",
  },
  {
    name: "score selection",
    route: "/api/auth/me/health-score-config",
    read: healthScoreConfig.GET,
    write: healthScoreConfig.PATCH,
    method: "PATCH",
    body: (_read, step) => ({
      pillars:
        step % 2 === 0
          ? ["BLOOD_PRESSURE", "SLEEP"]
          : ["BLOOD_PRESSURE", "SLEEP", "ACTIVITY"],
    }),
    errorCode: "health_score_config_conflict",
  },
];

beforeEach(async () => {
  await truncateAllTables(prisma);
  caches.dashboardWidgets.__resetForTests();
  caches.insightsLayout.__resetForTests();
  caches.medicationListLayout.__resetForTests();
});

async function read(surface: Surface, auth: Session): Promise<Doc> {
  const res = await callRoute<Doc>(surface.read, {
    method: "GET",
    route: surface.route,
    auth,
  });
  expect(res.status, `${surface.name} GET`).toBe(200);
  return res.data;
}

async function write(
  surface: Surface,
  auth: Session,
  body: Record<string, unknown>,
) {
  return callRoute<Doc>(surface.write, {
    method: surface.method,
    route: surface.route,
    body,
    auth,
  });
}

/** Save once without a token, so every surface has a stored document. */
async function seed(surface: Surface, auth: Session): Promise<Doc> {
  const initial = await read(surface, auth);
  const res = await write(surface, auth, surface.body(initial, 1));
  expect(res.status, `${surface.name} seed`).toBe(200);
  return read(surface, auth);
}

describe("each settings document locks on its own revision", () => {
  for (const surface of SURFACES) {
    it(`${surface.name}: a registry write, then a guarded save, succeeds`, async () => {
      const user = await makeUser();
      const auth = await makeSession(user);
      const loaded = await seed(surface, auth);
      expect(loaded.updatedAt).toEqual(expect.any(String));

      const registry = await callRoute(medicineRegistry.PATCH, {
        method: "PATCH",
        route: "/api/auth/me/medicine-registry",
        body: { medicineRegistry: "DE" },
        auth,
      });
      expect(registry.status).toBe(200);
      // An unrelated column on the same row: the row moved, the token not.
      await prisma.user.update({
        where: { id: user.id },
        data: { timezone: "Europe/Warsaw" },
      });

      const reread = await read(surface, auth);
      expect(reread.updatedAt).toBe(loaded.updatedAt);

      const saved = await write(surface, auth, {
        ...surface.body(reread, 2),
        baseUpdatedAt: loaded.updatedAt,
      });
      expect(saved.status, `${surface.name} guarded save`).toBe(200);
      expect(saved.data.updatedAt).not.toBe(loaded.updatedAt);

      // The guard still guards: the first token is stale now.
      const stale = await write(surface, auth, {
        ...surface.body(reread, 3),
        baseUpdatedAt: loaded.updatedAt,
      });
      expect(stale.status).toBe(409);
      expect(stale.meta?.errorCode).toBe(surface.errorCode);

      // And the token the save answered is the one the next read serves.
      expect((await read(surface, auth)).updatedAt).toBe(saved.data.updatedAt);
    });
  }

  it("serves the moved token after a write behind the route", async () => {
    const user = await makeUser();
    const auth = await makeSession(user);
    const medications = SURFACES[0];
    const loaded = await seed(medications, auth);

    // A restore, record settings or the wipe write the column directly and
    // evict nothing: the cached cell still holds the old token.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        medicationListLayoutJson: { version: 1, view: "table", order: [] },
      },
    });
    const reread = await read(medications, auth);
    expect(reread.updatedAt).not.toBe(loaded.updatedAt);
    expect(reread.view).toBe("table");

    const saved = await write(medications, auth, {
      ...medications.body(reread, 2),
      baseUpdatedAt: reread.updatedAt,
    });
    expect(saved.status).toBe(200);
  });

  it("does not move a token on a write of the same value", async () => {
    const user = await makeUser();
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { modulePreferencesJson: true, modulePreferencesRevisedAt: true },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { modulePreferencesJson: { mood: false } },
    });
    const written = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { modulePreferencesRevisedAt: true },
    });
    expect(written.modulePreferencesRevisedAt.getTime()).not.toBe(
      before.modulePreferencesRevisedAt.getTime(),
    );
    await prisma.user.update({
      where: { id: user.id },
      data: { modulePreferencesJson: { mood: false } },
    });
    const same = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { modulePreferencesRevisedAt: true },
    });
    expect(same.modulePreferencesRevisedAt).toEqual(
      written.modulePreferencesRevisedAt,
    );
  });
});

describe("the about-me revision", () => {
  async function revision(userId: string): Promise<number> {
    const row = await prisma.userHealthProfile.findUniqueOrThrow({
      where: { userId },
      select: { aboutMeRevisedAt: true },
    });
    return row.aboutMeRevisedAt.getTime();
  }

  it("moves with the about-me fields and not with the rest of the row", async () => {
    const user = await makeUser();
    await prisma.userHealthProfile.create({ data: { userId: user.id } });
    const created = await revision(user.id);

    await prisma.userHealthProfile.update({
      where: { userId: user.id },
      data: {
        emergencyBloodType: "A_POS",
        pendingQuestionsEncrypted: Buffer.from("x"),
        lifeConfirmedJson: { WORK: "2026-11-01T00:00:00.000Z" },
      },
    });
    expect(await revision(user.id)).toBe(created);

    await prisma.userHealthProfile.update({
      where: { userId: user.id },
      data: { aiIncludedSections: ["ABOUT_ME"] },
    });
    const afterSections = await revision(user.id);
    expect(afterSections).not.toBe(created);

    await prisma.userHealthProfile.update({
      where: { userId: user.id },
      data: { allergiesEncrypted: Buffer.from("y") },
    });
    expect(await revision(user.id)).not.toBe(afterSections);
  });
});
