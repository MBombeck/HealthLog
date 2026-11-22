/**
 * Official medication leaflets, step 1 (#1430), through the shipped routes
 * against a real Postgres:
 *
 *  - the medicine registry: settled once on the first `/api/auth/me` read
 *    from the language and zone, stored, and not moved by a later change of
 *    language; written by `PATCH /api/auth/me/medicine-registry`, which
 *    refuses a value outside the list with 422;
 *  - the saved leaflet link: created, read back on the list and the detail,
 *    left alone by an edit that does not name it, cleared by a blank or null,
 *    and refused with 422 when it is not an `https:` URL (`http:`,
 *    `javascript:`, `data:`, plain text, over the length cap);
 *  - `leafletSearch` on the detail, built for the CALLER's registry, and null
 *    when the caller chose none.
 *
 * `callRoute` checks every answer against the published contract, so an
 * undeclared key or a missing one fails there too.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as readMe } from "@/app/api/auth/me/route";
import { PATCH as patchRegistry } from "@/app/api/auth/me/medicine-registry/route";
import {
  GET as listMedications,
  POST as createMedication,
} from "@/app/api/medications/route";
import {
  GET as readMedication,
  PUT as updateMedication,
} from "@/app/api/medications/[id]/route";
import { LEAFLET_URL_MAX_CHARS } from "@/lib/medications/leaflet-url";

import { callRoute, type RouteAuth } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const LINK = "https://cima.aemps.es/cima/pdfs/es/p/12345/P_12345.pdf";

type MedicationWire = {
  id: string;
  leafletUrl: string | null;
  leafletSearch?: {
    registry: string;
    url: string;
    host: string;
    prefill: string;
    searchTerm: string;
  } | null;
};

let owner: RouteAuth;
let ownerId: string;

beforeEach(async () => {
  await truncateAllTables(prisma);
  const user = await makeUser({
    timezone: "Europe/Warsaw",
    locale: "pl",
  });
  ownerId = user.id;
  owner = await makeSession(user);
});

async function me(auth: RouteAuth = owner) {
  return callRoute<{ medicineRegistry: string }>(readMe, {
    method: "GET",
    route: "/api/auth/me",
    auth,
  });
}

async function setRegistry(body: unknown, auth: RouteAuth = owner) {
  return callRoute<{ medicineRegistry: string }>(patchRegistry, {
    method: "PATCH",
    route: "/api/auth/me/medicine-registry",
    body,
    auth,
  });
}

async function storedRegistry(userId = ownerId) {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { medicineRegistry: true },
  });
  return row.medicineRegistry;
}

async function create(body: Record<string, unknown>) {
  return callRoute<MedicationWire>(createMedication, {
    method: "POST",
    route: "/api/medications",
    body: {
      name: "Ramipril",
      dose: "5mg",
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

async function storedLink(id: string) {
  const row = await prisma.medication.findUniqueOrThrow({
    where: { id },
    select: { leafletUrl: true },
  });
  return row.leafletUrl;
}

describe("the medicine registry (#1430)", () => {
  it("settles once from the language and zone, then keeps it", async () => {
    expect(await storedRegistry()).toBeNull();
    const first = await me();
    expect(first.status).toBe(200);
    expect(first.data.medicineRegistry).toBe("PL");
    expect(await storedRegistry()).toBe("PL");

    // A later change of language does not move the stored registry.
    await prisma.user.update({
      where: { id: ownerId },
      data: { locale: "en", timezone: "Europe/London" },
    });
    expect((await me()).data.medicineRegistry).toBe("PL");
  });

  it("settles to NONE where language and zone do not agree", async () => {
    const user = await makeUser({ locale: "en", timezone: "Europe/Berlin" });
    const auth = await makeSession(user);
    expect((await me(auth)).data.medicineRegistry).toBe("NONE");
    expect(await storedRegistry(user.id)).toBe("NONE");
  });

  it("stores a chosen registry, audits it, and answers it", async () => {
    const res = await setRegistry({ medicineRegistry: "GB" });
    expect(res.status).toBe(200);
    expect(res.data.medicineRegistry).toBe("GB");
    expect(await storedRegistry()).toBe("GB");
    expect((await me()).data.medicineRegistry).toBe("GB");
    const audit = await prisma.auditLog.findFirst({
      where: { userId: ownerId, action: "user.medicine-registry.update" },
    });
    expect(audit).not.toBeNull();

    const none = await setRegistry({ medicineRegistry: "NONE" });
    expect(none.status).toBe(200);
    expect(await storedRegistry()).toBe("NONE");
  });

  it.each([
    [{ medicineRegistry: "UK" }],
    [{ medicineRegistry: "pl" }],
    [{ medicineRegistry: null }],
    [{}],
  ])("refuses %j with 422 and leaves the column alone", async (body) => {
    await setRegistry({ medicineRegistry: "DE" });
    const res = await setRegistry(body);
    expect(res.status).toBe(422);
    expect(await storedRegistry()).toBe("DE");
  });
});

describe("the saved leaflet link (#1430)", () => {
  it("stores, reads back, keeps and clears the link", async () => {
    const created = await create({ leafletUrl: `  ${LINK}  ` });
    expect(created.status).toBe(201);
    expect(created.data.leafletUrl).toBe(LINK);
    expect(await storedLink(created.data.id)).toBe(LINK);
    expect((await detail(created.data.id)).data.leafletUrl).toBe(LINK);
    expect((await list()).data[0].leafletUrl).toBe(LINK);

    // An edit that does not name the link leaves it alone.
    const renamed = await put(created.data.id, { name: "Ramipril Teva" });
    expect(renamed.status).toBe(200);
    expect(renamed.data.leafletUrl).toBe(LINK);

    const blank = await put(created.data.id, { leafletUrl: "  " });
    expect(blank.status).toBe(200);
    expect(blank.data.leafletUrl).toBeNull();
    expect(await storedLink(created.data.id)).toBeNull();

    await put(created.data.id, { leafletUrl: LINK });
    const nulled = await put(created.data.id, { leafletUrl: null });
    expect(nulled.data.leafletUrl).toBeNull();
    expect(await storedLink(created.data.id)).toBeNull();
  });

  it("serves null for a medication created without a link", async () => {
    const created = await create({});
    expect(created.status).toBe(201);
    expect(created.data.leafletUrl).toBeNull();
  });

  it.each([
    "http://example.org/leaflet.pdf",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "not a link",
    `https://example.org/${"a".repeat(LEAFLET_URL_MAX_CHARS)}`,
  ])("refuses %j with 422 on create and edit", async (bad) => {
    const refusedCreate = await create({ leafletUrl: bad });
    expect(refusedCreate.status).toBe(422);
    expect(await prisma.medication.count()).toBe(0);

    const { data } = await create({ leafletUrl: LINK });
    const refusedEdit = await put(data.id, { leafletUrl: bad });
    expect(refusedEdit.status).toBe(422);
    expect(await storedLink(data.id)).toBe(LINK);
  });
});

describe("leafletSearch on the medication detail (#1430)", () => {
  it("builds the caller's registry search, with no request made", async () => {
    await setRegistry({ medicineRegistry: "PL" });
    const { data } = await create({});
    const res = await detail(data.id);
    expect(res.status).toBe(200);
    expect(res.data.leafletSearch).toEqual({
      registry: "PL",
      authority: "Rejestr Produktów Leczniczych",
      url: "https://rejestry.ezdrowie.gov.pl/rpl/search?name=Ramipril",
      host: "rejestry.ezdrowie.gov.pl",
      prefill: "name",
      searchTerm: "Ramipril",
    });
    // The create and the edit answer what the detail answers.
    expect(data.leafletSearch).toEqual(res.data.leafletSearch);
    const edited = await put(data.id, { name: "Ramipril" });
    expect(edited.data.leafletSearch).toEqual(res.data.leafletSearch);
  });

  it("follows a change of registry, and is null for NONE", async () => {
    const { data } = await create({});
    await setRegistry({ medicineRegistry: "AU" });
    const au = await detail(data.id);
    expect(au.data.leafletSearch?.url).toBe(
      "https://www.tga.gov.au/resources/artg?keywords=Ramipril%205%20mg",
    );
    await setRegistry({ medicineRegistry: "NONE" });
    expect((await detail(data.id)).data.leafletSearch).toBeNull();
  });
});
