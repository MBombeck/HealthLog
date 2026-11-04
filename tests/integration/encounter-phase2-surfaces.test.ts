/**
 * The Phase 2 surfaces against real Postgres, through the real routes.
 *
 * Everything here is about ROWS — how many link rows exist, whether a second
 * call wrote a second satisfaction, which visits a filter actually returns —
 * and none of it can be answered by a mocked client. Three properties in
 * particular would pass a mock-shaped assertion while being wrong:
 *
 *   - filing a visit against a due checkup twice must satisfy it ONCE. A test
 *     phrased as "the second call returned 200" proves nothing; the assertion
 *     is that `lastSatisfiedAt` did not move.
 *   - a lab commit writes one link PER RESULT ROW. A test that counted "there
 *     is a link" would pass on a single link for a three-marker panel.
 *   - the visit list's episode filter runs in SQL over the link table. A test
 *     with one visit in the account cannot tell a filter from no filter, so
 *     there are always two.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { GET as listEncounters } from "@/app/api/encounters/route";
import { POST as createEncounter } from "@/app/api/encounters/route";
import { GET as suggestEncounter } from "@/app/api/encounters/suggest/route";
import { POST as commitOcr } from "@/app/api/labs/ocr/commit/route";
import { POST as bulkDocuments } from "@/app/api/documents/inbound/bulk/route";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

const OWNER_ID = "phase2-owner";

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function seedSession() {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "phase2-owner",
      email: "phase2-owner@example.test",
      timezone: "Europe/Berlin",
      // The document and lab surfaces are module-gated; the visit is not.
      modulePreferencesJson: {
        inboundDocuments: true,
        labs: true,
        illness: true,
      },
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: OWNER_ID,
      expiresAt: daysFromNow(7),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

function post(body: unknown): Promise<Response> {
  return createEncounter(
    new Request("http://localhost/api/encounters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

async function json<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedSession();
});

describe("filing a visit against a due checkup", () => {
  async function dueCheckup() {
    return getPrismaClient().measurementReminder.create({
      data: {
        userId: OWNER_ID,
        label: "Annual panel",
        measurementType: null,
        intervalDays: 365,
        anchorDate: daysFromNow(-400),
        notifyHour: 9,
        nextDueAt: daysFromNow(-35),
      },
    });
  }

  it("advances lastSatisfiedAt, and doing it twice does not advance it again", async () => {
    const prisma = getPrismaClient();
    const checkup = await dueCheckup();
    expect(checkup.lastSatisfiedAt).toBeNull();

    // ONE instant, captured once and reused. Two calls to `daysFromNow(-30)`
    // are milliseconds apart, and the second would be strictly later — which
    // the forward-only guard correctly advances on. The property under test is
    // the one that matters in the product: the SAME visit filed twice.
    const occurredAt = daysFromNow(-30).toISOString();

    const first = await post({
      occurredAt,
      status: "DONE",
      reminderId: checkup.id,
    });
    expect(first.status).toBe(201);

    const afterFirst = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });
    expect(afterFirst.lastSatisfiedAt).not.toBeNull();

    // The SAME instant again. `satisfyReminder` is forward-only, so this is a
    // no-op that still succeeds — the property the plan calls idempotent, and
    // the one a status-code assertion alone would not see.
    const second = await post({
      occurredAt,
      status: "DONE",
      reminderId: checkup.id,
    });
    expect(second.status).toBe(201);

    const afterSecond = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });
    expect(afterSecond.lastSatisfiedAt?.toISOString()).toBe(
      afterFirst.lastSatisfiedAt?.toISOString(),
    );
    expect(afterSecond.nextDueAt?.toISOString()).toBe(
      afterFirst.nextDueAt?.toISOString(),
    );
  });

  it("satisfies at the VISIT's instant rather than at now", async () => {
    const prisma = getPrismaClient();
    const checkup = await dueCheckup();
    const occurredAt = daysFromNow(-30);

    await post({
      occurredAt: occurredAt.toISOString(),
      status: "DONE",
      reminderId: checkup.id,
    });

    const after = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });
    // Satisfying at `now` would push next-due 365 days from today rather than
    // from the draw; the honest date is the visit's own.
    expect(after.lastSatisfiedAt?.toISOString()).toBe(occurredAt.toISOString());
  });

  it("leaves a checkup untouched when the visit is not done", async () => {
    const prisma = getPrismaClient();
    const checkup = await dueCheckup();

    const res = await post({
      occurredAt: daysFromNow(-30).toISOString(),
      status: "NO_SHOW",
      reminderId: checkup.id,
    });
    expect(res.status).toBe(201);

    const after = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });
    expect(after.lastSatisfiedAt).toBeNull();
  });
});

describe("a lab panel filed against a visit", () => {
  const rows = [
    { analyte: "LDL", value: 3.1, unit: "mmol/L" },
    { analyte: "HDL", value: 1.4, unit: "mmol/L" },
    { analyte: "Ferritin", value: 88, unit: "µg/L" },
  ];

  function commit(body: unknown): Promise<Response> {
    return commitOcr(
      new Request("http://localhost/api/labs/ocr/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }) as never,
    );
  }

  it("writes ONE link per result row", async () => {
    const prisma = getPrismaClient();
    const visit = await json<{ id: string }>(
      await post({ occurredAt: daysFromNow(-1).toISOString(), status: "DONE" }),
    );
    const takenAt = daysFromNow(-1).toISOString();

    const res = await commit({
      rows: rows.map((row) => ({ ...row, takenAt })),
      encounterId: visit.id,
    });
    expect(res.status).toBe(200);

    const results = await prisma.labResult.findMany({
      where: { userId: OWNER_ID },
    });
    expect(results).toHaveLength(3);

    const links = await prisma.encounterLabLink.findMany({
      where: { userId: OWNER_ID, encounterId: visit.id },
    });
    // Three, not one: a marker re-run on a different day belongs to its own
    // visit, which is why the join is m:n rather than a column on the result.
    expect(links).toHaveLength(3);
    expect(new Set(links.map((link) => link.labResultId))).toEqual(
      new Set(results.map((result) => result.id)),
    );
  });

  it("succeeds and writes no link when no visit is named", async () => {
    const prisma = getPrismaClient();
    const res = await commit({
      rows: [{ ...rows[0], takenAt: daysFromNow(-2).toISOString() }],
    });
    expect(res.status).toBe(200);

    expect(await prisma.labResult.count({ where: { userId: OWNER_ID } })).toBe(
      1,
    );
    expect(
      await prisma.encounterLabLink.count({ where: { userId: OWNER_ID } }),
    ).toBe(0);
  });
});

describe("filing documents against a visit in bulk", () => {
  async function seedDocuments(count: number): Promise<string[]> {
    const prisma = getPrismaClient();
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = await prisma.inboundDocument.create({
        data: {
          userId: OWNER_ID,
          kind: "OTHER",
          filename: `doc-${index}.pdf`,
          mimeType: "application/pdf",
          byteSize: 4,
          status: "STORED",
          contentEncrypted: Buffer.from("test"),
          contentCodec: "v1",
        },
      });
      ids.push(row.id);
    }
    return ids;
  }

  function bulk(body: unknown): Promise<Response> {
    return bulkDocuments(
      new Request("http://localhost/api/documents/inbound/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }) as never,
    );
  }

  it("links a whole batch, per entry, and is idempotent", async () => {
    const prisma = getPrismaClient();
    const visit = await json<{ id: string }>(
      await post({ occurredAt: daysFromNow(-1).toISOString(), status: "DONE" }),
    );
    const ids = await seedDocuments(100);

    const res = await bulk({
      ids,
      action: "linkEncounter",
      encounterId: visit.id,
    });
    expect(res.status).toBe(200);
    const first = await json<{ results: Array<{ ok: boolean }> }>(res);
    // Per-entry tolerance: a hundred outcomes, one per id, not one verdict.
    expect(first.results).toHaveLength(100);
    expect(first.results.every((row) => row.ok)).toBe(true);
    expect(
      await prisma.encounterDocumentLink.count({
        where: { userId: OWNER_ID, encounterId: visit.id },
      }),
    ).toBe(100);

    // Re-posting the same batch changes nothing and still succeeds.
    const again = await bulk({
      ids,
      action: "linkEncounter",
      encounterId: visit.id,
    });
    expect(again.status).toBe(200);
    expect(
      await prisma.encounterDocumentLink.count({
        where: { userId: OWNER_ID, encounterId: visit.id },
      }),
    ).toBe(100);
  });

  it("reports one unknown id as one failed row and files the rest", async () => {
    const prisma = getPrismaClient();
    const visit = await json<{ id: string }>(
      await post({ occurredAt: daysFromNow(-1).toISOString(), status: "DONE" }),
    );
    const ids = await seedDocuments(2);

    const res = await bulk({
      ids: [...ids, "not-a-document"],
      action: "linkEncounter",
      encounterId: visit.id,
    });
    const payload = await json<{
      results: Array<{ id: string; ok: boolean; error: string | null }>;
    }>(res);
    expect(payload.results).toHaveLength(3);
    expect(payload.results.filter((row) => row.ok)).toHaveLength(2);
    expect(
      payload.results.find((row) => row.id === "not-a-document")?.error,
    ).toBe("notFound");
    expect(
      await prisma.encounterDocumentLink.count({ where: { userId: OWNER_ID } }),
    ).toBe(2);
  });

  it("refuses the whole batch when the visit is not the caller's", async () => {
    const prisma = getPrismaClient();
    const ids = await seedDocuments(2);
    const res = await bulk({
      ids,
      action: "linkEncounter",
      encounterId: "someone-elses-visit",
    });
    expect(res.status).toBe(404);
    expect(
      await prisma.encounterDocumentLink.count({ where: { userId: OWNER_ID } }),
    ).toBe(0);
  });
});

describe("the visit list's condition filter", () => {
  it("returns only the visits filed against that episode", async () => {
    const prisma = getPrismaClient();
    const episode = await prisma.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Knee",
        type: "INJURY",
        onsetAt: daysFromNow(-40),
      },
    });

    const linked = await json<{ id: string }>(
      await post({
        occurredAt: daysFromNow(-5).toISOString(),
        status: "DONE",
        episodeIds: [episode.id],
      }),
    );
    // A SECOND visit with no link. Without it a filter and no filter return
    // the same list and the assertion below would prove nothing.
    await post({ occurredAt: daysFromNow(-6).toISOString(), status: "DONE" });

    const res = await listEncounters(
      new Request(
        `http://localhost/api/encounters?episodeId=${episode.id}`,
      ) as never,
    );
    expect(res.status).toBe(200);
    const list = await json<{
      upcoming: Array<{ id: string }>;
      past: Array<{ id: string }>;
    }>(res);
    expect(list.past.map((row) => row.id)).toEqual([linked.id]);

    const unfiltered = await json<{ past: Array<{ id: string }> }>(
      await listEncounters(
        new Request("http://localhost/api/encounters") as never,
      ),
    );
    expect(unfiltered.past).toHaveLength(2);
  });
});

describe("the visit list carries its links", () => {
  it("resolves every family on a list row, not only on the detail", async () => {
    const prisma = getPrismaClient();
    const episode = await prisma.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Knee",
        type: "INJURY",
        onsetAt: daysFromNow(-40),
      },
    });
    const document = await prisma.inboundDocument.create({
      data: {
        userId: OWNER_ID,
        kind: "OTHER",
        filename: "letter.pdf",
        mimeType: "application/pdf",
        byteSize: 4,
        status: "STORED",
        contentEncrypted: Buffer.from("test"),
        contentCodec: "v1",
      },
    });

    await post({
      occurredAt: daysFromNow(-3).toISOString(),
      status: "DONE",
      episodeIds: [episode.id],
      documentIds: [document.id],
    });

    const list = await json<{
      past: Array<{
        links?: {
          documents: unknown[];
          labResults: unknown[];
          conditions: unknown[];
        };
      }>;
    }>(
      await listEncounters(
        new Request("http://localhost/api/encounters") as never,
      ),
    );
    expect(list.past).toHaveLength(1);
    // Without this the card counts read zero for a visit that produced two
    // things, and an edit opened from the row would unfile both on save.
    expect(list.past[0]!.links?.documents).toHaveLength(1);
    expect(list.past[0]!.links?.conditions).toHaveLength(1);
    expect(list.past[0]!.links?.labResults).toHaveLength(0);
  });
});

describe("the suggestion, over real rows", () => {
  function suggest(anchor: string): Promise<Response> {
    return suggestEncounter(
      new Request(
        `http://localhost/api/encounters/suggest?anchor=${encodeURIComponent(anchor)}`,
      ) as never,
    );
  }

  it("pre-selects a single candidate and offers a picker for two", async () => {
    const anchor = daysFromNow(-3);

    const only = await json<{ id: string }>(
      await post({ occurredAt: daysFromNow(-2).toISOString(), status: "DONE" }),
    );
    const one = await json<{ kind: string; encounter: { id: string } }>(
      await suggest(anchor.toISOString()),
    );
    expect(one.kind).toBe("one");
    expect(one.encounter.id).toBe(only.id);

    await post({ occurredAt: daysFromNow(-4).toISOString(), status: "DONE" });
    const many = await json<{ kind: string; encounters: unknown[] }>(
      await suggest(anchor.toISOString()),
    );
    expect(many.kind).toBe("many");
    expect(many.encounters).toHaveLength(2);
    // No pre-selection on the two-candidate arm — the shape itself has none.
    expect(many).not.toHaveProperty("encounter");
  });

  it("offers nothing outside the window, and nothing for a soft-deleted visit", async () => {
    const prisma = getPrismaClient();
    await post({ occurredAt: daysFromNow(-30).toISOString(), status: "DONE" });
    const far = await json<{ kind: string }>(
      await suggest(new Date().toISOString()),
    );
    expect(far.kind).toBe("none");

    const near = await json<{ id: string }>(
      await post({ occurredAt: daysFromNow(-1).toISOString(), status: "DONE" }),
    );
    await prisma.encounter.update({
      where: { id: near.id },
      data: { deletedAt: new Date() },
    });
    const tombstoned = await json<{ kind: string }>(
      await suggest(new Date().toISOString()),
    );
    expect(tombstoned.kind).toBe("none");
  });
});
