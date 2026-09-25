/**
 * Body sites on conditions and the body-site view, against real Postgres and
 * through the real routes (v1.39.2).
 *
 * What only a real database can answer:
 *
 *   - the two new columns exist (migration 0354) and the site is ciphertext on
 *     disk, not the words the person typed;
 *   - an edit from the shipped iPhone app, whose body never names the site,
 *     leaves the stored site and side exactly as they were;
 *   - the view groups sites across procedures and conditions and walks one hop
 *     to what is linked to each, through the link service's real tables;
 *   - a delegate learns nothing a grant does not cover: without the illness
 *     section there is no condition, no condition-only site and no condition
 *     name; a link into an ungranted section is a placeholder with no label.
 *
 * Mutation checks (each run, each seen red):
 *   - pass `conditionsReadable: true` unconditionally in the route → both
 *     "profile-only delegate" cases go red (the condition-only site appears);
 *   - pass `() => true` as the condition document redaction predicate →
 *     "profile + illness delegate" goes red (the letter's title leaks);
 *   - write `bodySiteEncrypted: null` unconditionally in the PATCH → "an edit
 *     from the shipped iPhone app" goes red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import type { ShareDomain } from "@/lib/sharing/scope";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import type { BodySiteListDTO } from "@/lib/body-sites/dto";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const OWNER_ID = "body-site-owner";
const DELEGATE_ID = "body-site-delegate";

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: daysFromNow(1), mfaVerifiedAt: new Date() },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function switchInto(scope: ShareDomain[] | null) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: OWNER_ID,
    granteeId: DELEGATE_ID,
    access: "READ",
    scope,
  });
  await acceptGrant({ grantId: invited.id, granteeId: DELEGATE_ID });
  const session = await signIn(DELEGATE_ID);
  await switchSessionTo(session.id, OWNER_ID);
}

async function seedRecord() {
  const prisma = getPrismaClient();
  for (const [id, name] of [
    [OWNER_ID, "owner"],
    [DELEGATE_ID, "delegate"],
  ] as const) {
    await prisma.user.create({
      data: {
        id,
        username: `body-site-${name}`,
        email: `body-site-${name}@example.test`,
        timezone: "Europe/Berlin",
        locale: "en",
      },
    });
  }

  const mri = await prisma.inboundDocument.create({
    data: {
      userId: OWNER_ID,
      kind: "OTHER",
      title: "MRI knee report",
      mimeType: "application/pdf",
      byteSize: 10,
      contentEncrypted: new Uint8Array([1, 2, 3]),
      contentCodec: "binary2",
      documentDate: daysFromNow(-40),
    },
  });
  const physio = await prisma.inboundDocument.create({
    data: {
      userId: OWNER_ID,
      kind: "OTHER",
      title: "Physio letter",
      mimeType: "application/pdf",
      byteSize: 10,
      contentEncrypted: new Uint8Array([1, 2, 3]),
      contentCodec: "binary2",
      documentDate: daysFromNow(-20),
    },
  });
  const crp = await prisma.labResult.create({
    data: {
      userId: OWNER_ID,
      analyte: "CRP",
      value: 4,
      unit: "mg/L",
      takenAt: daysFromNow(-30),
    },
  });
  const tear = await prisma.illnessEpisode.create({
    data: {
      userId: OWNER_ID,
      label: "Meniscus tear",
      type: "INJURY",
      onsetAt: daysFromNow(-60),
      bodySiteEncrypted: encryptToBytes("knee"),
      laterality: "LEFT",
    },
  });
  const lumbago = await prisma.illnessEpisode.create({
    data: {
      userId: OWNER_ID,
      label: "Lumbago",
      type: "CHRONIC",
      onsetAt: daysFromNow(-400),
      bodySiteEncrypted: encryptToBytes("Lower back"),
    },
  });
  const arthroscopy = await prisma.encounter.create({
    data: {
      userId: OWNER_ID,
      occurredAt: daysFromNow(-30),
      status: "DONE",
      kind: "PROCEDURE",
      reasonEncrypted: encryptToBytes("Arthroscopy"),
      bodySiteEncrypted: encryptToBytes("Knee"),
      laterality: "LEFT",
    },
  });
  await prisma.encounter.create({
    data: {
      userId: OWNER_ID,
      occurredAt: daysFromNow(-500),
      status: "DONE",
      kind: "PROCEDURE",
      reasonEncrypted: encryptToBytes("Rotator cuff repair"),
      bodySiteEncrypted: encryptToBytes("Shoulder"),
      laterality: "RIGHT",
    },
  });
  // A visit with no site never appears in the view.
  await prisma.encounter.create({
    data: {
      userId: OWNER_ID,
      occurredAt: daysFromNow(-5),
      status: "DONE",
      kind: "ROUTINE",
    },
  });
  await prisma.encounterDocumentLink.create({
    data: { userId: OWNER_ID, encounterId: arthroscopy.id, documentId: mri.id },
  });
  await prisma.encounterLabLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: arthroscopy.id,
      labResultId: crp.id,
    },
  });
  await prisma.encounterConditionLink.create({
    data: { userId: OWNER_ID, encounterId: arthroscopy.id, episodeId: tear.id },
  });
  await prisma.documentConditionLink.create({
    data: { userId: OWNER_ID, documentId: physio.id, episodeId: tear.id },
  });
  return { mri, physio, crp, tear, lumbago, arthroscopy };
}

async function bodySites(
  query = "",
): Promise<{ status: number; body: { data: BodySiteListDTO } }> {
  const { GET } = await import("@/app/api/body-sites/route");
  const res = await GET(
    new Request(
      `http://localhost/api/body-sites${query ? `?${query}` : ""}`,
    ) as never,
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("GET /api/body-sites — the owner", () => {
  it("groups sites across procedures and conditions", async () => {
    await seedRecord();
    await signIn(OWNER_ID);
    const { status, body } = await bodySites();
    expect(status).toBe(200);
    expect(body.data.selection).toBeUndefined();
    expect(body.data.sites).toEqual([
      {
        bodySite: "Knee",
        procedures: 1,
        conditions: 1,
        sides: [{ laterality: "LEFT", count: 2 }],
      },
      {
        bodySite: "Shoulder",
        procedures: 1,
        conditions: 0,
        sides: [{ laterality: "RIGHT", count: 1 }],
      },
      {
        bodySite: "Lower back",
        procedures: 0,
        conditions: 1,
        sides: [{ laterality: null, count: 1 }],
      },
    ]);
  });

  it("walks from a site to its procedures, conditions and their links", async () => {
    const seeded = await seedRecord();
    await signIn(OWNER_ID);
    const { status, body } = await bodySites("site=KNEE&laterality=LEFT");
    expect(status).toBe(200);
    const selection = body.data.selection!;
    expect(selection.bodySite).toBe("Knee");
    expect(selection.laterality).toBe("LEFT");

    expect(selection.visits.map((v) => v.id)).toEqual([seeded.arthroscopy.id]);
    const links = selection.visits[0].links!;
    expect(links.documents).toEqual([
      expect.objectContaining({ label: "MRI knee report", redacted: false }),
    ]);
    expect(links.labResults).toEqual([
      expect.objectContaining({ label: "CRP", redacted: false }),
    ]);
    expect(links.conditions).toEqual([
      expect.objectContaining({ label: "Meniscus tear", redacted: false }),
    ]);

    expect(selection.conditions).toHaveLength(1);
    const condition = selection.conditions![0];
    expect(condition).toMatchObject({
      id: seeded.tear.id,
      label: "Meniscus tear",
      bodySite: "knee",
      laterality: "LEFT",
    });
    expect(condition.links.documents).toEqual([
      expect.objectContaining({ label: "Physio letter", redacted: false }),
    ]);
    expect(condition.links.visits).toEqual([
      expect.objectContaining({
        id: seeded.arthroscopy.id,
        label: "PROCEDURE",
        redacted: false,
      }),
    ]);
  });

  it("a picked side leaves out the other side", async () => {
    await seedRecord();
    await signIn(OWNER_ID);
    const { body } = await bodySites("site=Knee&laterality=RIGHT");
    expect(body.data.selection!.visits).toEqual([]);
    expect(body.data.selection!.conditions).toEqual([]);
  });

  it("with the illness module off, conditions are not read", async () => {
    await seedRecord();
    await getPrismaClient().user.update({
      where: { id: OWNER_ID },
      data: { modulePreferencesJson: { illness: false } },
    });
    await signIn(OWNER_ID);
    const { body } = await bodySites("site=Knee");
    expect(body.data.sites.map((s) => s.bodySite)).toEqual([
      "Knee",
      "Shoulder",
    ]);
    expect(body.data.selection!.conditions).toBeNull();
    expect(body.data.selection!.visits).toHaveLength(1);
  });

  it("refuses a side without a site", async () => {
    await seedRecord();
    await signIn(OWNER_ID);
    const { status } = await bodySites("laterality=LEFT");
    expect(status).toBe(422);
  });
});

describe("GET /api/body-sites — delegates", () => {
  it("profile-only delegate: no condition, no condition site, placeholders for links", async () => {
    await seedRecord();
    await switchInto(["profile"]);

    const list = await bodySites();
    expect(list.status).toBe(200);
    // The condition-only site is not among the choices, and the knee counts
    // only the procedure.
    expect(list.body.data.sites).toEqual([
      expect.objectContaining({
        bodySite: "Knee",
        procedures: 1,
        conditions: 0,
      }),
      expect.objectContaining({ bodySite: "Shoulder" }),
    ]);

    const { status, body } = await bodySites("site=Knee&laterality=LEFT");
    expect(status).toBe(200);
    const selection = body.data.selection!;
    expect(selection.conditions).toBeNull();
    const links = selection.visits[0].links!;
    for (const family of [
      links.documents,
      links.labResults,
      links.conditions,
    ]) {
      expect(family).toHaveLength(1);
      expect(family[0]).toMatchObject({
        label: null,
        date: null,
        redacted: true,
      });
    }
    // Nothing a grant did not cover appears anywhere in the answer.
    const text = JSON.stringify(body);
    for (const secret of [
      "Meniscus",
      "Lumbago",
      "Lower back",
      "MRI knee report",
      "Physio letter",
      "CRP",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("profile + illness delegate: conditions, with their documents as placeholders", async () => {
    await seedRecord();
    await switchInto(["profile", "illness"]);
    const { status, body } = await bodySites("site=Knee");
    expect(status).toBe(200);
    const selection = body.data.selection!;
    expect(selection.conditions).toHaveLength(1);
    expect(selection.conditions![0].label).toBe("Meniscus tear");
    expect(selection.conditions![0].links.documents).toEqual([
      expect.objectContaining({ label: null, date: null, redacted: true }),
    ]);
    // The visit's condition link is readable now; its document still is not.
    const links = selection.visits[0].links!;
    expect(links.conditions[0]).toMatchObject({
      label: "Meniscus tear",
      redacted: false,
    });
    expect(links.documents[0]).toMatchObject({ label: null, redacted: true });
    const text = JSON.stringify(body);
    expect(text).not.toContain("Physio letter");
    expect(text).not.toContain("MRI knee report");
  });

  it("a grant without the visits' section is refused", async () => {
    await seedRecord();
    await switchInto(["illness"]);
    const { status } = await bodySites();
    expect(status).toBe(403);
  });
});

describe("condition body site on the episode routes", () => {
  async function patchEpisode(id: string, body: unknown) {
    const { PATCH } = await import("@/app/api/illness/episodes/[id]/route");
    return PATCH(
      new Request(`http://localhost/api/illness/episodes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }) as never,
      { params: Promise.resolve({ id }) } as never,
    );
  }

  it("stores the site as ciphertext", async () => {
    await seedRecord();
    await signIn(OWNER_ID);
    const { POST } = await import("@/app/api/illness/episodes/route");
    const res = await POST(
      new Request("http://localhost/api/illness/episodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Tennis elbow",
          type: "INJURY",
          bodySite: "Elbow",
          laterality: "RIGHT",
        }),
      }) as never,
    );
    expect(res.status).toBe(201);
    const created = (await res.json()).data as { id: string };
    const row = await getPrismaClient().illnessEpisode.findUniqueOrThrow({
      where: { id: created.id },
      select: { bodySiteEncrypted: true, laterality: true },
    });
    expect(Buffer.from(row.bodySiteEncrypted!).toString("utf8")).not.toContain(
      "Elbow",
    );
    expect(decryptFromBytes(row.bodySiteEncrypted!)).toBe("Elbow");
    expect(row.laterality).toBe("RIGHT");
  });

  it("an edit from the shipped iPhone app leaves the site and side alone", async () => {
    const { tear } = await seedRecord();
    await signIn(OWNER_ID);
    // What `IllnessEpisodePatch` encodes for "mark recovered with a note":
    // optional scalars only when set, the three full-value keys always.
    const res = await patchEpisode(tear.id, {
      resolvedAt: daysFromNow(-1).toISOString(),
      parentConditionId: null,
      note: "Back to running",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()).data as {
      bodySite: string | null;
      laterality: string | null;
    };
    expect(body.bodySite).toBe("knee");
    expect(body.laterality).toBe("LEFT");
    const row = await getPrismaClient().illnessEpisode.findUniqueOrThrow({
      where: { id: tear.id },
      select: { bodySiteEncrypted: true, laterality: true, resolvedAt: true },
    });
    expect(decryptFromBytes(row.bodySiteEncrypted!)).toBe("knee");
    expect(row.laterality).toBe("LEFT");
    expect(row.resolvedAt).not.toBeNull();
  });

  it("the web client can change and clear it", async () => {
    const { tear } = await seedRecord();
    await signIn(OWNER_ID);
    await patchEpisode(tear.id, { bodySite: "Left knee", laterality: null });
    let row = await getPrismaClient().illnessEpisode.findUniqueOrThrow({
      where: { id: tear.id },
      select: { bodySiteEncrypted: true, laterality: true },
    });
    expect(decryptFromBytes(row.bodySiteEncrypted!)).toBe("Left knee");
    expect(row.laterality).toBeNull();
    await patchEpisode(tear.id, { bodySite: null });
    row = await getPrismaClient().illnessEpisode.findUniqueOrThrow({
      where: { id: tear.id },
      select: { bodySiteEncrypted: true, laterality: true },
    });
    expect(row.bodySiteEncrypted).toBeNull();
  });
});
