/**
 * The links an MCP read lists beside a lab reading, a medication and a
 * document, against real Postgres and the real link tables.
 *
 * What the unit suites cannot show: that the link service's owner narrowing
 * keeps another account's document out of every list (including through a
 * link row that points across accounts), that a switched-off Documents module
 * drops document links without reading them, that an imported document names
 * its source system and id but never its instance address, and that the cap
 * says when it cut a list short.
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.APP_URL ??= "http://localhost";

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { linkTargets } from "@/lib/links";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { MAX_LINKS, type RecordLink } from "@/lib/mcp/record-links";
import type { McpAuthContext } from "@/lib/mcp/auth";

import { getPrismaClient, truncateAllTables } from "./setup";

const ctx = (userId: string): McpAuthContext => ({
  userId,
  tokenId: "t",
  scopes: ["health:read"],
  binding: `${userId}:t`,
  canRead: true,
  canWrite: false,
});

function tool(name: string) {
  const def = MCP_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def;
}

let counter = 0;

async function makeUser(modules: Record<string, boolean> = {}) {
  const suffix = `${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `mcp-links-${suffix}`,
      email: `mcp-links-${suffix}@example.test`,
      timezone: "UTC",
      modulePreferencesJson: modules,
    },
  });
}

async function makeDocument(
  userId: string,
  title: string,
  source?: { system: string; id: string },
) {
  return getPrismaClient().inboundDocument.create({
    data: {
      userId,
      title,
      mimeType: "application/pdf",
      byteSize: 4,
      contentEncrypted: encryptToBytes("pdf!"),
      documentDate: new Date("2026-03-01T00:00:00Z"),
      ...(source
        ? {
            sourceSystem: source.system,
            sourceId: source.id,
            sourceInstance: "https://paperless.example.test",
          }
        : {}),
    },
  });
}

async function makeLab(
  userId: string,
  analyte: string,
  takenAt: string,
  value = 120,
) {
  return getPrismaClient().labResult.create({
    data: {
      userId,
      analyte,
      value,
      unit: "mg/dL",
      takenAt: new Date(takenAt),
    },
  });
}

/**
 * One account's record: an LDL reading read from an imported report and filed
 * against a visit, an older unlinked LDL reading, an HDL reading from the same
 * report, a medication filed against the report, a condition.
 */
async function seedRecord(userId: string) {
  const db = getPrismaClient();
  const report = await makeDocument(userId, "Lipid panel", {
    system: "PAPERLESS",
    id: "1234",
  });
  const visit = await db.encounter.create({
    data: {
      userId,
      occurredAt: new Date("2026-03-01T09:00:00Z"),
      kind: "ROUTINE",
    },
  });
  const ldl = await makeLab(userId, "LDL", "2026-03-01T09:00:00Z");
  const olderLdl = await makeLab(userId, "LDL", "2025-03-01T09:00:00Z");
  const hdl = await makeLab(userId, "HDL", "2026-03-01T09:00:00Z");
  const med = await db.medication.create({
    data: { userId, name: "Atorvastatin", dose: "20mg" },
  });
  const condition = await db.illnessEpisode.create({
    data: {
      userId,
      label: "Knee pain",
      type: "INJURY",
      onsetAt: new Date("2026-02-01T00:00:00Z"),
    },
  });
  await linkTargets(db, {
    userId,
    sourceKind: "labResult",
    sourceId: ldl.id,
    targetKind: "document",
    targetIds: [report.id],
  });
  await linkTargets(db, {
    userId,
    sourceKind: "labResult",
    sourceId: hdl.id,
    targetKind: "document",
    targetIds: [report.id],
  });
  await linkTargets(db, {
    userId,
    sourceKind: "encounter",
    sourceId: visit.id,
    targetKind: "labResult",
    targetIds: [ldl.id],
  });
  await linkTargets(db, {
    userId,
    sourceKind: "medication",
    sourceId: med.id,
    targetKind: "document",
    targetIds: [report.id],
  });
  return { report, visit, ldl, olderLdl, hdl, med, condition };
}

type Reading = {
  analyte?: string;
  links: string[];
  linksTruncated: boolean;
  history?: { earlier: Array<{ links: string[]; linksTruncated: boolean }> };
};
type LabsAnswer = {
  present: boolean;
  data: { recent: Reading[] };
  linkedRecords: RecordLink[];
};
type FetchAnswer = {
  title: string;
  text: string;
  metadata: Record<string, unknown> & {
    links?: RecordLink[];
    linksTruncated?: boolean;
  };
};

const fetchId = async (userId: string, id: string) =>
  (await tool("fetch").run(ctx(userId), { id })) as FetchAnswer;

const analyteOf = (r: Reading) =>
  (r.analyte ?? "").replace(/<<<[A-Z_]+>>>/g, "");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("get_labs lists each reading's links", () => {
  it("names a linked report once, with its source system and id but no address", async () => {
    const user = await makeUser();
    const r = await seedRecord(user.id);

    const answer = (await tool("get_labs").run(ctx(user.id), {})) as LabsAnswer;
    const ldl = answer.data.recent.find((x) => analyteOf(x) === "LDL")!;
    const hdl = answer.data.recent.find((x) => analyteOf(x) === "HDL")!;
    expect(ldl.links).toEqual([
      `document:${r.report.id}`,
      `visit:${r.visit.id}`,
    ]);
    expect(ldl.linksTruncated).toBe(false);
    expect(hdl.links).toEqual([`document:${r.report.id}`]);
    // The report both readings came from is described once.
    const docs = answer.linkedRecords.filter((l) => l.kind === "document");
    expect(docs).toEqual([
      {
        id: `document:${r.report.id}`,
        kind: "document",
        label: "Lipid panel",
        date: "2026-03-01",
        sourceSystem: "PAPERLESS",
        sourceId: "1234",
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain("paperless.example.test");
    // Each reading carries its own fetch id, and no bare lab result id is left.
    expect((ldl as Reading & { id?: string }).id).toBe(`labresult:${r.ldl.id}`);
    expect(JSON.stringify(answer).split(r.ldl.id)).toHaveLength(2);
  });

  it("lists the links of earlier values and of a trajectory, [] when none", async () => {
    const user = await makeUser();
    const r = await seedRecord(user.id);

    const named = (await tool("get_labs").run(ctx(user.id), {
      analyte: "LDL",
    })) as LabsAnswer;
    const [entry] = named.data.recent;
    expect(entry.links).toEqual([
      `document:${r.report.id}`,
      `visit:${r.visit.id}`,
    ]);
    expect(entry.history?.earlier).toEqual([
      expect.objectContaining({ links: [], linksTruncated: false }),
    ]);

    const trajectory = (await tool("get_labs").run(ctx(user.id), {
      analyte: "LDL",
      history: true,
    })) as { readings: Array<{ links: string[] }>; linkedRecords: unknown[] };
    expect(trajectory.readings.map((x) => x.links)).toEqual([
      [`document:${r.report.id}`, `visit:${r.visit.id}`],
      [],
    ]);
    expect(trajectory.linkedRecords).toHaveLength(2);
  });

  it("drops document links while the Documents module is off", async () => {
    const user = await makeUser({ inboundDocuments: false });
    const r = await seedRecord(user.id);

    const answer = (await tool("get_labs").run(ctx(user.id), {})) as LabsAnswer;
    const ldl = answer.data.recent.find((x) => analyteOf(x) === "LDL")!;
    expect(ldl.links).toEqual([`visit:${r.visit.id}`]);
    expect(answer.linkedRecords.map((l) => l.kind)).toEqual(["visit"]);

    const lab = await fetchId(user.id, "lab:LDL");
    expect(lab.metadata.links?.map((l) => l.kind)).toEqual(["visit"]);
    const med = await fetchId(user.id, `med:${r.med.id}`);
    expect(med.metadata.links).toEqual([]);
    expect(med.text).toContain("Linked records: none.");
  });
});

describe("fetch lists a lab's and a medication's links", () => {
  it("lists the latest reading's links, with the source in the prose", async () => {
    const user = await makeUser();
    const r = await seedRecord(user.id);

    const lab = await fetchId(user.id, "lab:LDL");
    expect(lab.metadata.links?.map((l) => l.id)).toEqual([
      `document:${r.report.id}`,
      `visit:${r.visit.id}`,
    ]);
    expect(lab.metadata.linksTruncated).toBe(false);
    expect(lab.text).toContain("Linked records: document");
    expect(lab.text).toContain("PAPERLESS id");

    const med = await fetchId(user.id, `med:${r.med.id}`);
    expect(med.metadata.links).toEqual([
      expect.objectContaining({
        id: `document:${r.report.id}`,
        sourceSystem: "PAPERLESS",
        sourceId: "1234",
      }),
    ]);
  });

  it("says Linked records: none for a reading linked to nothing", async () => {
    const user = await makeUser();
    await makeLab(user.id, "Ferritin", "2026-01-01T09:00:00Z");
    const lab = await fetchId(user.id, "lab:Ferritin");
    expect(lab.metadata.links).toEqual([]);
    expect(lab.metadata.linksTruncated).toBe(false);
    expect(lab.text).toContain("Linked records: none.");
  });

  it("caps a long list and says it did", async () => {
    const user = await makeUser();
    const db = getPrismaClient();
    const med = await db.medication.create({
      data: { userId: user.id, name: "Ramipril", dose: "5mg" },
    });
    const docs = [];
    for (let i = 0; i < MAX_LINKS + 3; i += 1) {
      docs.push(await makeDocument(user.id, `Plan ${i}`));
    }
    await linkTargets(db, {
      userId: user.id,
      sourceKind: "medication",
      sourceId: med.id,
      targetKind: "document",
      targetIds: docs.map((d) => d.id),
    });

    const fetched = await fetchId(user.id, `med:${med.id}`);
    expect(fetched.metadata.links).toHaveLength(MAX_LINKS);
    expect(fetched.metadata.linksTruncated).toBe(true);

    const schedule = (await tool("get_medication_schedule").run(
      ctx(user.id),
      {},
    )) as {
      medications: Array<{
        id: string;
        links: RecordLink[];
        linksTruncated: boolean;
      }>;
    };
    expect(schedule.medications[0].id).toBe(`med:${med.id}`);
    expect(schedule.medications[0].links).toHaveLength(MAX_LINKS);
    expect(schedule.medications[0].linksTruncated).toBe(true);
  });
});

describe("fetch document lists the labs and medications filed against it", () => {
  it("names the lab results read from it and the medications", async () => {
    const user = await makeUser();
    const r = await seedRecord(user.id);
    const doc = await fetchId(user.id, `document:${r.report.id}`);
    expect(doc.metadata.links?.map((l) => l.id)).toEqual([
      `labresult:${r.ldl.id}`,
      `labresult:${r.hdl.id}`,
      `med:${r.med.id}`,
    ]);
    expect(doc.text).toContain("Linked records: lab");
    expect(doc.text).toContain("medication");
  });

  it("leaves out labs and medications whose module is off", async () => {
    const user = await makeUser({ labs: false, medications: false });
    const r = await seedRecord(user.id);
    const doc = await fetchId(user.id, `document:${r.report.id}`);
    expect(doc.metadata.links).toEqual([]);
  });
});

describe("a link to a lab result lands on the reading that record holds", () => {
  /**
   * Two reports a year apart with an LDL reading each, plus a second report
   * dated the same day as the later one with its own LDL reading. `lab:LDL`
   * answers with the latest; a link from a report must not.
   */
  async function seedDraws(userId: string) {
    const db = getPrismaClient();
    const earlier = await makeDocument(userId, "Lipid panel 2025");
    const later = await makeDocument(userId, "Lipid panel 2026");
    const sameDay = await makeDocument(userId, "Second lab, same day");
    const visit = await db.encounter.create({
      data: {
        userId,
        occurredAt: new Date("2025-03-01T09:00:00Z"),
        kind: "ROUTINE",
      },
    });
    const early = await makeLab(userId, "LDL", "2025-03-01T09:00:00Z", 160);
    const late = await makeLab(userId, "LDL", "2026-03-01T09:00:00Z", 110);
    const twin = await makeLab(userId, "LDL", "2026-03-01T09:00:00Z", 115);
    for (const [lab, doc] of [
      [early, earlier],
      [late, later],
      [twin, sameDay],
    ] as const) {
      await linkTargets(db, {
        userId,
        sourceKind: "labResult",
        sourceId: lab.id,
        targetKind: "document",
        targetIds: [doc.id],
      });
    }
    await linkTargets(db, {
      userId,
      sourceKind: "encounter",
      sourceId: visit.id,
      targetKind: "labResult",
      targetIds: [early.id],
    });
    return { earlier, later, sameDay, visit, early, late, twin };
  }

  const linkIds = (answer: FetchAnswer) =>
    (answer.metadata.links ?? []).map((l) => l.id);

  it("from a report, a visit and get_labs, each id fetches that reading", async () => {
    const user = await makeUser();
    const d = await seedDraws(user.id);

    const fromEarlier = await fetchId(user.id, `document:${d.earlier.id}`);
    expect(linkIds(fromEarlier)).toEqual([`labresult:${d.early.id}`]);
    const reading = await fetchId(user.id, `labresult:${d.early.id}`);
    expect(reading.text).toContain("LDL: 160 mg/dL");
    expect(reading.text).toContain("measured 2025-03-01");
    expect(reading.metadata.value).toBe(160);
    expect(linkIds(reading)).toEqual([
      `document:${d.earlier.id}`,
      `visit:${d.visit.id}`,
    ]);
    expect(linkIds(reading)).not.toContain(`document:${d.later.id}`);

    // The visit the earlier draw is filed against links the same reading.
    const visit = await fetchId(user.id, `visit:${d.visit.id}`);
    expect(linkIds(visit)).toContain(`labresult:${d.early.id}`);

    // Two reports on one day: each lands on its own reading.
    for (const [doc, lab, value] of [
      [d.later, d.late, 110],
      [d.sameDay, d.twin, 115],
    ] as const) {
      const fromDoc = await fetchId(user.id, `document:${doc.id}`);
      expect(linkIds(fromDoc)).toEqual([`labresult:${lab.id}`]);
      const own = await fetchId(user.id, `labresult:${lab.id}`);
      expect(own.metadata.value).toBe(value);
      expect(linkIds(own)).toEqual([`document:${doc.id}`]);
    }

    // The analyte view is unchanged: the latest reading, named by its id.
    const latest = await fetchId(user.id, "lab:LDL");
    expect(latest.metadata.readingId).toMatch(/^labresult:/);
    expect([`labresult:${d.late.id}`, `labresult:${d.twin.id}`]).toContain(
      latest.metadata.readingId,
    );

    // Every reading get_labs lists carries an id that fetch takes back.
    const trajectory = (await tool("get_labs").run(ctx(user.id), {
      analyte: "LDL",
      history: true,
    })) as { readings: Array<{ id: string; value: number }> };
    expect(trajectory.readings).toHaveLength(3);
    for (const r of trajectory.readings) {
      const back = await fetchId(user.id, r.id);
      expect(back.metadata.value).toBe(r.value);
    }
  });

  it("does not resolve another account's, a deleted or a switched-off reading", async () => {
    const me = await makeUser();
    const other = await makeUser();
    const mine = await seedDraws(me.id);
    const theirs = await seedDraws(other.id);

    const foreign = await fetchId(me.id, `labresult:${theirs.early.id}`);
    expect(foreign.title).toBe("Not found");
    expect(JSON.stringify(foreign)).not.toContain(theirs.earlier.id);

    await getPrismaClient().labResult.update({
      where: { id: mine.early.id },
      data: { deletedAt: new Date() },
    });
    const deleted = await fetchId(me.id, `labresult:${mine.early.id}`);
    expect(deleted.title).toBe("Not found");
    const report = await fetchId(me.id, `document:${mine.earlier.id}`);
    expect(linkIds(report)).toEqual([]);

    const off = await makeUser({ labs: false });
    const offDraws = await seedDraws(off.id);
    const gated = await fetchId(off.id, `labresult:${offDraws.late.id}`);
    expect(gated.metadata.reason).toBe("module_disabled");
  });
});

describe("list rows carry the id fetch takes", () => {
  it("on visits, the medication schedule and conditions", async () => {
    const user = await makeUser();
    const r = await seedRecord(user.id);

    const visits = (await tool("get_visits").run(ctx(user.id), {
      months: 60,
    })) as { visits: Array<{ id: string }> };
    expect(visits.visits.map((v) => v.id)).toEqual([`visit:${r.visit.id}`]);

    const schedule = (await tool("get_medication_schedule").run(
      ctx(user.id),
      {},
    )) as { medications: Array<{ id: string; links: RecordLink[] }> };
    expect(schedule.medications.map((m) => m.id)).toEqual([`med:${r.med.id}`]);
    expect(schedule.medications[0].links.map((l) => l.id)).toEqual([
      `document:${r.report.id}`,
    ]);

    const illness = (await tool("get_illness_recovery").run(
      ctx(user.id),
      {},
    )) as { data: { illness: { active: Array<{ id: string }> } } };
    expect(illness.data.illness.active.map((c) => c.id)).toEqual([
      `condition:${r.condition.id}`,
    ]);
  });
});

describe("another account's records never appear", () => {
  it("not through its own links, nor through a link row pointing across", async () => {
    const me = await makeUser();
    const other = await makeUser();
    const mine = await seedRecord(me.id);
    const theirs = await seedRecord(other.id);
    // A link row in my account naming the other account's report: the target
    // re-read is narrowed to my account, so it must drop out.
    await getPrismaClient().labResultDocumentLink.create({
      data: {
        userId: me.id,
        labResultId: mine.ldl.id,
        documentId: theirs.report.id,
      },
    });
    await getPrismaClient().medicationDocumentLink.create({
      data: {
        userId: me.id,
        medicationId: mine.med.id,
        documentId: theirs.report.id,
      },
    });

    const labs = JSON.stringify(await tool("get_labs").run(ctx(me.id), {}));
    const lab = JSON.stringify(await fetchId(me.id, "lab:LDL"));
    const med = JSON.stringify(await fetchId(me.id, `med:${mine.med.id}`));
    const schedule = JSON.stringify(
      await tool("get_medication_schedule").run(ctx(me.id), {}),
    );
    for (const answer of [labs, lab, med, schedule]) {
      expect(answer).toContain(mine.report.id);
      expect(answer).not.toContain(theirs.report.id);
      expect(answer).not.toContain(theirs.visit.id);
    }
    const foreign = await fetchId(me.id, `document:${theirs.report.id}`);
    expect(foreign.title).toBe("Not found");
    const myDoc = JSON.stringify(
      await fetchId(me.id, `document:${mine.report.id}`),
    );
    expect(myDoc).not.toContain(theirs.med.id);
  });
});
