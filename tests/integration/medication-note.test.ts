/**
 * The medication's own note (#1371), driven through the shipped routes against
 * a real Postgres: create with a note, read it back on the list and the detail,
 * change it, leave it alone on an edit that does not name it, clear it, and
 * refuse one that is too long. The column is read raw as well, because a route
 * that answered with the note while storing it in the clear would pass every
 * wire assertion. `callRoute` checks each answer against the published
 * contract, which refuses an undeclared key: a reader that leaked the
 * `noteEncrypted` column onto the wire fails there.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  GET as listMedications,
  POST as createMedication,
} from "@/app/api/medications/route";
import {
  GET as readMedication,
  PUT as updateMedication,
} from "@/app/api/medications/[id]/route";
import { MEDICATION_NOTE_MAX_CHARS } from "@/lib/validations/medication";

import { callRoute, type RouteAuth } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const NOTE = "30 to 60 minutes before food";

let owner: RouteAuth;

beforeEach(async () => {
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "UTC" });
  owner = await makeSession(user);
});

type MedicationWire = { id: string; note: string | null };

async function create(body: Record<string, unknown>) {
  return callRoute<MedicationWire>(createMedication, {
    method: "POST",
    route: "/api/medications",
    body: {
      name: "Levothyroxine",
      dose: "50 µg",
      schedules: [{ windowStart: "07:00", windowEnd: "08:00" }],
      ...body,
    },
    auth: owner,
  });
}

async function put(id: string, body: Record<string, unknown>) {
  return callRoute<MedicationWire>(updateMedication, {
    method: "PUT",
    route: "/api/medications/{id}",
    params: { id },
    body,
    auth: owner,
  });
}

async function detail(id: string) {
  return callRoute<MedicationWire>(readMedication, {
    method: "GET",
    route: "/api/medications/{id}",
    params: { id },
    auth: owner,
  });
}

async function list() {
  return callRoute<MedicationWire[]>(listMedications, {
    method: "GET",
    route: "/api/medications",
    auth: owner,
  });
}

async function storedColumn(id: string) {
  const row = await prisma.medication.findUniqueOrThrow({
    where: { id },
    select: { noteEncrypted: true },
  });
  return row.noteEncrypted;
}

describe("the medication's own note (#1371)", () => {
  it("stores the note sealed and serves it decrypted on every read", async () => {
    const created = await create({ note: `  ${NOTE}  ` });
    expect(created.status).toBe(201);
    expect(created.data.note).toBe(NOTE);
    expect(created.data).not.toHaveProperty("noteEncrypted");

    const sealed = await storedColumn(created.data.id);
    expect(sealed).not.toBeNull();
    expect(Buffer.from(sealed!).toString("utf8")).not.toContain("before food");

    const one = await detail(created.data.id);
    expect(one.status).toBe(200);
    expect(one.data.note).toBe(NOTE);

    const all = await list();
    expect(all.status).toBe(200);
    expect(all.data).toHaveLength(1);
    expect(all.data[0].note).toBe(NOTE);
    expect(all.data[0]).not.toHaveProperty("noteEncrypted");
  });

  it("serves null for a medication created without a note", async () => {
    const created = await create({});
    expect(created.status).toBe(201);
    expect(created.data.note).toBeNull();
    expect(await storedColumn(created.data.id)).toBeNull();
  });

  it("changes, keeps and clears the note on edit", async () => {
    const { data } = await create({ note: NOTE });

    const changed = await put(data.id, { note: "With food" });
    expect(changed.status).toBe(200);
    expect(changed.data.note).toBe("With food");

    // An edit that does not name the note leaves it alone.
    const renamed = await put(data.id, { name: "Euthyrox" });
    expect(renamed.status).toBe(200);
    expect(renamed.data.note).toBe("With food");
    expect((await list()).data[0].note).toBe("With food");

    // A blank string clears it, and so does null.
    const blank = await put(data.id, { note: "   " });
    expect(blank.status).toBe(200);
    expect(blank.data.note).toBeNull();
    expect(await storedColumn(data.id)).toBeNull();

    await put(data.id, { note: "Again" });
    const nulled = await put(data.id, { note: null });
    expect(nulled.data.note).toBeNull();
    expect(await storedColumn(data.id)).toBeNull();
  });

  it("refuses a note over the limit with 422 and leaves the stored one", async () => {
    const { data } = await create({ note: NOTE });
    const tooLong = "x".repeat(MEDICATION_NOTE_MAX_CHARS + 1);

    const refusedEdit = await put(data.id, { note: tooLong });
    expect(refusedEdit.status).toBe(422);
    expect((await detail(data.id)).data.note).toBe(NOTE);

    const refusedCreate = await create({ name: "Other", note: tooLong });
    expect(refusedCreate.status).toBe(422);
    expect(await prisma.medication.count()).toBe(1);

    // At the limit, after trimming, it is accepted.
    const atLimit = "y".repeat(MEDICATION_NOTE_MAX_CHARS);
    const accepted = await put(data.id, { note: `  ${atLimit}  ` });
    expect(accepted.status).toBe(200);
    expect(accepted.data.note).toBe(atLimit);
  });
});
