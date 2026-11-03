/**
 * v1.42.2 (#1117) — `POST /api/search` against real Postgres.
 *
 * What the unit tests cannot show: that encrypted text is found after the
 * decrypt whichever way the umlaut is typed, that the reads are narrowed to
 * the record the session acts for (two accounts hold the same words here),
 * that a switched-off module's rows are not read, that the per-source row cap
 * really bounds a large record and says so, and that a delegate reads the
 * owner's record only through a whole-record grant.
 *
 * Mutation checks (each run, each seen red):
 *   - drop `userId: ctx.recordId` from the mood-note read → "never returns the
 *     other account's records" goes red;
 *   - drop the `search:moodNote` surface entry → "a switched-off module
 *     contributes nothing" goes red;
 *   - let `scanNewest` read past `MAX_SCAN_ROWS_PER_SOURCE` → "stops at the
 *     scan cap" goes red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { encryptNote } from "@/lib/crypto/note-cipher";
import type { SearchHit, SearchResponse } from "@/lib/search/contract";
import { MAX_SCAN_ROWS_PER_SOURCE } from "@/lib/search/search-records";

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

let counter = 0;

async function makeUser(label: string, modules: Record<string, boolean> = {}) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `rs-${suffix}`,
      email: `rs-${suffix}@example.test`,
      displayName: `RS ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "de",
      modulePreferencesJson: modules,
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

async function search(q: string, limit?: number): Promise<Response> {
  const { POST } = await import("@/app/api/search/route");
  return (
    POST as unknown as (
      req: NextRequest,
      ctx: { params: Promise<object> },
    ) => Promise<Response>
  )(
    new NextRequest("http://localhost/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(limit ? { q, limit } : { q }),
    }),
    { params: Promise.resolve({}) },
  );
}

async function hits(q: string, limit?: number): Promise<SearchResponse> {
  const res = await search(q, limit);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: SearchResponse }).data;
}

function all(result: SearchResponse): SearchHit[] {
  return result.groups.flatMap((g) => g.hits);
}

/** One account's record holding "Schulter" in every source that can hold it. */
async function seedRecord(userId: string, tag: string) {
  const db = getPrismaClient();
  const visit = await db.encounter.create({
    data: {
      userId,
      occurredAt: new Date("2026-03-02T09:00:00Z"),
      kind: "PROCEDURE",
      reasonEncrypted: encryptToBytes(`Arthroskopie ${tag}`),
      bodySiteEncrypted: encryptToBytes("Schulter"),
      laterality: "LEFT",
    },
  });
  const condition = await db.illnessEpisode.create({
    data: {
      userId,
      label: `Schulterprellung ${tag}`,
      type: "INJURY",
      onsetAt: new Date("2026-02-20T09:00:00Z"),
    },
  });
  const mood = await db.moodEntry.create({
    data: {
      userId,
      date: "2026-03-05",
      mood: "OKAY",
      score: 3,
      moodLoggedAt: new Date("2026-03-05T18:00:00Z"),
      noteEncrypted: encryptNote(`Die SCHULTER zwickt ${tag}`),
    },
  });
  const reading = await db.measurement.create({
    data: {
      userId,
      type: "WEIGHT",
      value: 80,
      unit: "kg",
      measuredAt: new Date("2026-03-06T07:00:00Z"),
      notesEncrypted: encryptNote(`nach der Schulter-OP ${tag}`),
    },
  });
  const medication = await db.medication.create({
    data: { userId, name: `Ibuprofen ${tag}`, dose: "400 mg" },
  });
  const lab = await db.labResult.create({
    data: {
      userId,
      analyte: "Hämoglobin",
      value: 14,
      unit: "g/dL",
      takenAt: new Date("2026-03-01T08:00:00Z"),
    },
  });
  const symptom = await db.symptomDefinition.create({
    data: { userId, labelEncrypted: encryptToBytes(`Schulterschmerz ${tag}`) },
  });
  const document = await db.inboundDocument.create({
    data: {
      userId,
      title: `MRT Schulter ${tag}`,
      mimeType: "application/pdf",
      byteSize: 4,
      contentEncrypted: encryptToBytes("%PDF"),
      kind: "IMAGING",
    },
  });
  return {
    visit,
    condition,
    mood,
    reading,
    medication,
    lab,
    symptom,
    document,
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("the record search", () => {
  it("finds encrypted and plaintext records, case and umlaut blind, each with a path that opens it", async () => {
    const owner = await makeUser("owner");
    const mine = await seedRecord(owner.id, "eigen");
    await signIn(owner.id);

    const result = await hits("schulter", 20);
    const byId = new Map(all(result).map((h) => [h.id, h]));

    expect(byId.get(`visit:${mine.visit.id}`)?.path).toBe(
      `/checkups?visit=${mine.visit.id}`,
    );
    expect(byId.get(`condition:${mine.condition.id}`)?.path).toBe(
      `/illness/${mine.condition.id}`,
    );
    expect(byId.get(`document:${mine.document.id}`)?.path).toBe(
      `/documents?doc=${mine.document.id}`,
    );
    expect(byId.get(`moodNote:${mine.mood.id}`)?.path).toBe(
      "/mood?day=2026-03-05",
    );
    expect(byId.get(`measurementNote:${mine.reading.id}`)?.path).toBe(
      "/measurements?day=2026-03-06",
    );
    expect(byId.get(`symptom:${mine.symptom.id}`)?.path).toBe(
      `/illness?symptom=${mine.symptom.id}`,
    );

    // The note's snippet marks the word as the person wrote it.
    const mood = byId.get(`moodNote:${mine.mood.id}`)!;
    expect(mood.source).toBe("mood");
    const [[start, end]] = mood.snippet!.marks;
    expect(mood.snippet!.text.slice(start, end)).toBe("SCHULTER");

    // The visit names its site in context, in the reader's language.
    const visit = byId.get(`visit:${mine.visit.id}`)!;
    expect(visit.title?.text).toBe("Arthroskopie eigen");
    expect(visit.context.map((c) => c.text).join(" ")).toContain("Schulter");

    // Umlauts typed either way, in either direction.
    const lab = all(await hits("haemoglobin"));
    expect(lab.map((h) => h.path)).toContain(
      `/labs?analyte=${encodeURIComponent("Hämoglobin")}`,
    );
    expect(all(await hits("HÄMOGLOBIN")).length).toBeGreaterThan(0);

    const meds = all(await hits("ibuprofen"));
    expect(meds.map((h) => h.path)).toEqual([
      `/medications/${mine.medication.id}`,
    ]);
  });

  it("never returns the other account's records", async () => {
    const owner = await makeUser("owner");
    const other = await makeUser("other");
    await seedRecord(owner.id, "eigen");
    const theirs = await seedRecord(other.id, "fremd");
    await signIn(owner.id);

    const found = all(await hits("schulter", 20));
    expect(found.length).toBeGreaterThan(5);
    const theirIds = new Set(
      Object.values(theirs).map((row) => (row as { id: string }).id),
    );
    for (const hit of found) {
      expect(theirIds.has(hit.id.slice(hit.id.indexOf(":") + 1))).toBe(false);
      expect(JSON.stringify(hit)).not.toContain("fremd");
    }
    expect(all(await hits("fremd"))).toEqual([]);
  });

  it("a switched-off module contributes nothing", async () => {
    const owner = await makeUser("owner", {
      mood: false,
      illness: false,
      medications: false,
    });
    const mine = await seedRecord(owner.id, "eigen");
    await signIn(owner.id);

    const found = all(await hits("schulter", 20));
    const ids = found.map((h) => h.id);
    expect(ids).toContain(`visit:${mine.visit.id}`);
    expect(ids).not.toContain(`moodNote:${mine.mood.id}`);
    expect(ids).not.toContain(`condition:${mine.condition.id}`);
    expect(ids).not.toContain(`symptom:${mine.symptom.id}`);
    expect(found.map((h) => h.kind)).not.toContain("condition");
    expect(all(await hits("ibuprofen"))).toEqual([]);
  });

  it("stops at the scan cap on a large record and says so", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("owner");
    // The one matching note is the oldest; newer than it sit more noted
    // readings than one search reads.
    await db.measurement.create({
      data: {
        userId: owner.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date("2020-01-01T07:00:00Z"),
        notesEncrypted: encryptNote("Schulter"),
      },
    });
    const filler = Array.from(
      { length: MAX_SCAN_ROWS_PER_SOURCE + 10 },
      (_, i) => ({
        userId: owner.id,
        type: "WEIGHT" as const,
        value: 80,
        unit: "kg",
        measuredAt: new Date(Date.UTC(2021, 0, 1) + i * 3_600_000),
        notesEncrypted: encryptNote(`Waage ${i}`),
      }),
    );
    await db.measurement.createMany({ data: filler });
    await signIn(owner.id);

    const capped = await hits("schulter");
    expect(capped.truncated).toBe(true);
    expect(all(capped)).toEqual([]);

    // A newer match is found inside the cap, and the answer is not cut short
    // when there is no more to read.
    expect(all(await hits("Waage", 3)).length).toBe(3);
  });

  it("caps each group and says when there is more", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("owner");
    for (let i = 0; i < 4; i++) {
      await db.moodEntry.create({
        data: {
          userId: owner.id,
          date: `2026-01-0${i + 1}`,
          mood: "OKAY",
          score: 3,
          moodLoggedAt: new Date(`2026-01-0${i + 1}T18:00:00Z`),
          noteEncrypted: encryptNote(`Kopfweh ${i}`),
        },
      });
    }
    await signIn(owner.id);
    const result = await hits("kopfweh", 2);
    const notes = result.groups.find((g) => g.kind === "note")!;
    expect(notes.hits).toHaveLength(2);
    expect(notes.more).toBe(true);
    // Newest first on a tie.
    expect(notes.hits[0].day).toBe("2026-01-04");
  });

  it("a delegate searches the owner's record through a whole-record grant only", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const mine = await seedRecord(owner.id, "eigen");
    await seedRecord(delegate.id, "selbst");
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");

    const whole = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: null,
    });
    await acceptGrant({ grantId: whole.id, granteeId: delegate.id });
    const session = await signIn(delegate.id);
    await switchSessionTo(session.id, owner.id);

    const found = all(await hits("schulter", 20));
    expect(found.map((h) => h.id)).toContain(`visit:${mine.visit.id}`);
    expect(JSON.stringify(found)).not.toContain("selbst");
  });

  it("a grant scoped to some sections does not open it", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await seedRecord(owner.id, "eigen");
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const scoped = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "READ",
      scope: ["profile"],
    });
    await acceptGrant({ grantId: scoped.id, granteeId: delegate.id });
    const session = await signIn(delegate.id);
    await switchSessionTo(session.id, owner.id);

    const res = await search("schulter");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Schulter");
  });

  it("refuses a query too short to search", async () => {
    const owner = await makeUser("owner");
    await signIn(owner.id);
    expect((await search("s")).status).toBe(422);
  });

  it("reads the noted readings through the partial index", async () => {
    const db = getPrismaClient();
    const owner = await makeUser("owner");
    await db.measurement.createMany({
      data: Array.from({ length: 2000 }, (_, i) => ({
        userId: owner.id,
        type: "PULSE" as const,
        value: 60,
        unit: "bpm",
        measuredAt: new Date(Date.UTC(2024, 0, 1) + i * 60_000),
      })),
    });
    await db.$executeRawUnsafe("ANALYZE measurements");
    const plan = await db.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN SELECT id FROM measurements
         WHERE user_id = $1 AND deleted_at IS NULL
           AND (notes_encrypted IS NOT NULL OR notes IS NOT NULL)
         ORDER BY measured_at DESC, id DESC LIMIT 250`,
      owner.id,
    );
    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain(
      "measurements_noted_live_idx",
    );
  });
});
