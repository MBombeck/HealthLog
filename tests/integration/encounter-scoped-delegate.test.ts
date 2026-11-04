/**
 * What a NARROWLY scoped delegate may learn, and may do, through a visit.
 *
 * Visits sit in the health-background domain and link out to three others: the
 * document vault, the lab results and the illness journal. That makes a visit a
 * seam between domains, and a seam is where a scoped grant leaks.
 *
 * Two properties, both about somebody holding `profile` and nothing else:
 *
 *   1. **Names do not flow through the seam.** The values never did — the link
 *      list carries an id, a label and a date, not the document body or the
 *      analyte's result. But "Ferritin, 30 June" and "Oncology discharge
 *      letter" are themselves the sensitive part, and a grant that opened only
 *      the health background was never consent for them. A delegate without
 *      the target's domain gets the shape of the link and not its name.
 *   2. **Closing a checkup needs the checkup's domain.** Satisfying one
 *      re-anchors a preventive-care cadence, which is a measurements-domain
 *      write. A profile-only delegate filing a visit still files it; the
 *      closure is skipped and SAID, rather than performed silently or refused
 *      with the whole request.
 *
 * The owner is checked in every case too, because a fix that reads "hide it
 * from everyone" would satisfy half of these and break the product.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import type { ShareDomain } from "@/lib/sharing/scope";

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

const OWNER_ID = "scoped-visit-owner";
const DELEGATE_ID = "scoped-visit-delegate";

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: daysFromNow(1) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

/** Sign in as the delegate and switch into the owner's record. */
async function switchInto(
  access: "READ" | "WRITE" | "MANAGE",
  scope: ShareDomain[] | null,
) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: OWNER_ID,
    granteeId: DELEGATE_ID,
    access,
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
        username: `scoped-visit-${name}`,
        email: `scoped-visit-${name}@example.test`,
        timezone: "Europe/Berlin",
      },
    });
  }

  const document = await prisma.inboundDocument.create({
    data: {
      userId: OWNER_ID,
      kind: "LAB_RESULT",
      title: "Oncology discharge letter",
      mimeType: "application/pdf",
      byteSize: 10,
      contentEncrypted: new Uint8Array([1, 2, 3]),
      contentCodec: "binary2",
      documentDate: daysFromNow(-3),
    },
  });
  const labResult = await prisma.labResult.create({
    data: {
      userId: OWNER_ID,
      analyte: "Ferritin",
      panel: "Iron panel",
      value: 91,
      unit: "ng/mL",
      takenAt: daysFromNow(-3),
    },
  });
  const episode = await prisma.illnessEpisode.create({
    data: {
      userId: OWNER_ID,
      label: "Hashimoto thyroiditis",
      type: "AUTOIMMUNE",
      onsetAt: daysFromNow(-200),
    },
  });
  const encounter = await prisma.encounter.create({
    data: {
      userId: OWNER_ID,
      occurredAt: daysFromNow(-2),
      status: "DONE",
      kind: "SPECIALIST",
    },
  });
  await prisma.encounterDocumentLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: encounter.id,
      documentId: document.id,
    },
  });
  await prisma.encounterLabLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: encounter.id,
      labResultId: labResult.id,
    },
  });
  await prisma.encounterConditionLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: encounter.id,
      episodeId: episode.id,
    },
  });
  return { document, labResult, episode, encounter };
}

type Link = {
  id: string;
  label: string | null;
  date: string | null;
  redacted: boolean;
};

type Links = {
  documents: Link[];
  labResults: Link[];
  conditions: Link[];
};

async function readLinks(encounterId: string): Promise<Links> {
  const { GET } = await import("@/app/api/encounters/[id]/route");
  const res = await GET(
    new Request(`http://localhost/api/encounters/${encounterId}`) as never,
    { params: Promise.resolve({ id: encounterId }) } as never,
  );
  expect(res.status).toBe(200);
  const parsed = (await res.json()) as { data: { links: Links } };
  return parsed.data.links;
}

/**
 * The SAME visit, read off the LIST rather than the detail.
 *
 * The list resolves links through `loadEncounterLinksForMany` — the batched
 * arm of the same service, a distinct code path from the detail's
 * `loadEncounterLinks`. It applies the same per-family redaction from the same
 * predicate, and it has to be proven separately: a batched read that dropped
 * the redaction would leak "Ferritin, 30 June" to a delegate the single read
 * withholds it from, and no assertion on the detail path would notice.
 */
async function readListLinks(encounterId: string): Promise<Links> {
  const { GET } = await import("@/app/api/encounters/route");
  const res = await GET(
    new Request("http://localhost/api/encounters") as never,
  );
  expect(res.status).toBe(200);
  const parsed = (await res.json()) as {
    data: {
      upcoming: Array<{ id: string; links?: Links }>;
      past: Array<{ id: string; links?: Links }>;
    };
  };
  const row = [...parsed.data.upcoming, ...parsed.data.past].find(
    (entry) => entry.id === encounterId,
  );
  expect(row, "the visit is in the list response").toBeDefined();
  expect(
    row!.links,
    "the list carries the links, not only the detail",
  ).toBeDefined();
  return row!.links!;
}

let seeded: Awaited<ReturnType<typeof seedRecord>>;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  seeded = await seedRecord();
});

describe("link labels follow the target's own domain", () => {
  it("gives the owner every name", async () => {
    await signIn(OWNER_ID);
    const links = await readLinks(seeded.encounter.id);

    expect(links.documents[0]!.label).toBe("Oncology discharge letter");
    expect(links.labResults[0]!.label).toBe("Iron panel · Ferritin");
    expect(links.conditions[0]!.label).toBe("Hashimoto thyroiditis");
    expect(links.documents[0]!.redacted).toBe(false);
  });

  it("gives an entire-record delegate every name", async () => {
    await switchInto("READ", null);
    const links = await readLinks(seeded.encounter.id);

    // The ordinary sharing case must not change.
    expect(links.documents[0]!.label).toBe("Oncology discharge letter");
    expect(links.labResults[0]!.label).toBe("Iron panel · Ferritin");
    expect(links.conditions[0]!.label).toBe("Hashimoto thyroiditis");
  });

  it("withholds all three names from a profile-only delegate", async () => {
    await switchInto("READ", ["profile"]);
    const links = await readLinks(seeded.encounter.id);

    // The links still exist — the visit produced three things and saying so is
    // within the grant. What they are called is not.
    expect(links.documents).toHaveLength(1);
    expect(links.labResults).toHaveLength(1);
    expect(links.conditions).toHaveLength(1);

    // Null rather than an invented placeholder: the server is not telling
    // this caller what the thing is called, and inventing a name here would
    // make an absence look like a value. The array the entry sits in is the
    // kind, so the client still renders "a linked lab result" from its own
    // bundle without the server shipping English down the wire.
    for (const link of [
      links.documents[0]!,
      links.labResults[0]!,
      links.conditions[0]!,
    ]) {
      expect(link.label).toBeNull();
      expect(link.redacted).toBe(true);
      // The date is the other half of the identification and goes with the name.
      expect(link.date).toBeNull();
      // The id stays: it is already the caller's own link row.
      expect(link.id).toBeTruthy();
    }
  });

  it("reveals only the domain the delegate actually holds", async () => {
    await switchInto("READ", ["profile", "labs"]);
    const links = await readLinks(seeded.encounter.id);

    // The point of doing this per target rather than all-or-nothing.
    expect(links.labResults[0]!.label).toBe("Iron panel · Ferritin");
    expect(links.labResults[0]!.redacted).toBe(false);
    expect(links.documents[0]!.label).toBeNull();
    expect(links.conditions[0]!.label).toBeNull();
  });
});

describe("the list path redacts the same seam as the detail path", () => {
  it("gives an entire-record delegate every name on the list", async () => {
    await switchInto("READ", null);
    const links = await readListLinks(seeded.encounter.id);

    // The ordinary sharing case: the batched read must not withhold from a
    // grant that covers everything. Without this leg, the redaction assertion
    // below could pass against a batched read that redacts unconditionally.
    expect(links.documents[0]!.label).toBe("Oncology discharge letter");
    expect(links.labResults[0]!.label).toBe("Iron panel · Ferritin");
    expect(links.conditions[0]!.label).toBe("Hashimoto thyroiditis");
    expect(links.documents[0]!.redacted).toBe(false);
  });

  it("withholds all three names from a profile-only delegate on the list", async () => {
    await switchInto("READ", ["profile"]);
    const links = await readListLinks(seeded.encounter.id);

    // The shape survives — the card counts what the visit produced — and the
    // names do not. This is the property the batched read has to hold on its
    // own, because the card and the edit sheet both read links off the list.
    expect(links.documents).toHaveLength(1);
    expect(links.labResults).toHaveLength(1);
    expect(links.conditions).toHaveLength(1);

    for (const link of [
      links.documents[0]!,
      links.labResults[0]!,
      links.conditions[0]!,
    ]) {
      expect(link.label).toBeNull();
      expect(link.date).toBeNull();
      expect(link.redacted).toBe(true);
      // The id is the caller's own link row and stays.
      expect(link.id).toBeTruthy();
    }
  });

  it("reveals only the held domain on the list", async () => {
    await switchInto("READ", ["profile", "labs"]);
    const links = await readListLinks(seeded.encounter.id);

    // Per-family on the batched path too: labs is held, the other two are not.
    expect(links.labResults[0]!.label).toBe("Iron panel · Ferritin");
    expect(links.labResults[0]!.redacted).toBe(false);
    expect(links.documents[0]!.label).toBeNull();
    expect(links.documents[0]!.redacted).toBe(true);
    expect(links.conditions[0]!.label).toBeNull();
    expect(links.conditions[0]!.redacted).toBe(true);
  });
});

describe("closing a checkup needs the checkup's own domain", () => {
  async function seedCheckup() {
    return getPrismaClient().measurementReminder.create({
      data: {
        userId: OWNER_ID,
        label: "Annual blood panel",
        intervalDays: 365,
        anchorDate: daysFromNow(-370),
        notifyHour: 9,
        nextDueAt: daysFromNow(-5),
      },
    });
  }

  async function fileVisit(reminderId: string) {
    const { POST } = await import("@/app/api/encounters/route");
    return POST(
      new Request("http://localhost/api/encounters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          occurredAt: daysFromNow(-1).toISOString(),
          status: "DONE",
          reminderId,
        }),
      }) as never,
    );
  }

  it("closes it for the owner", async () => {
    const checkup = await seedCheckup();
    await signIn(OWNER_ID);

    expect((await fileVisit(checkup.id)).status).toBe(201);
    expect(
      (
        await getPrismaClient().measurementReminder.findUniqueOrThrow({
          where: { id: checkup.id },
        })
      ).lastSatisfiedAt,
    ).not.toBeNull();
  });

  it("files the visit but skips the closure for a profile-only delegate", async () => {
    const checkup = await seedCheckup();
    await switchInto("WRITE", ["profile"]);

    const res = await fileVisit(checkup.id);
    // The visit is theirs to file; refusing the whole request over a side
    // effect they cannot perform would lose the record for no gain.
    expect(res.status).toBe(201);
    const parsed = (await res.json()) as {
      data: {
        skipped: { links: number; catalogueKeys: Array<{ key: string }> };
      };
    };

    // Skipped, and SAID. Silence here is the failure mode: the person would
    // believe a checkup was closed that is still due.
    expect(parsed.data.skipped.links).toBe(1);
    expect(parsed.data.skipped.catalogueKeys[0]!.key).toBe(checkup.id);

    expect(
      (
        await getPrismaClient().measurementReminder.findUniqueOrThrow({
          where: { id: checkup.id },
        })
      ).lastSatisfiedAt,
    ).toBeNull();
    expect(await getPrismaClient().encounter.count()).toBe(2);
  });

  it("closes it for a delegate who holds measurements too", async () => {
    const checkup = await seedCheckup();
    await switchInto("WRITE", ["profile", "measurements"]);

    const res = await fileVisit(checkup.id);
    expect(res.status).toBe(201);
    const parsed = (await res.json()) as {
      data: { skipped: { links: number } };
    };
    expect(parsed.data.skipped.links).toBe(0);
    expect(
      (
        await getPrismaClient().measurementReminder.findUniqueOrThrow({
          where: { id: checkup.id },
        })
      ).lastSatisfiedAt,
    ).not.toBeNull();
  });
});
