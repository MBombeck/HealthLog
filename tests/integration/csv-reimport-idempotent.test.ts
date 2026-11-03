/**
 * v1.39.3 — importing the same large CSV twice.
 *
 * A re-upload of a 9 000-row export with an externalId column ended in a 500:
 * every row already existed, so the route ran one update per row, serially,
 * inside a single interactive transaction, and that outlived Prisma's 5 s
 * timeout. Only a real database shows it. This imports the same file twice and
 * then a lightly edited copy, and reads the table back after each pass.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "user-csv-reimport";

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

const HEADER = "type,value,unit,measuredAt,glucoseContext,notes,externalId";
const ROWS = 9000;

/** 8 000 externalId rows and 1 000 without one, a minute apart. */
function fileLines(changed: ReadonlySet<number> = new Set()): string[] {
  return Array.from({ length: ROWS }, (_, i) => {
    const at = new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString();
    const value = (70 + (i % 50) / 10 + (changed.has(i) ? 1 : 0)).toFixed(1);
    const note = i % 100 === 0 ? "after the long ride" : "";
    const externalId = i < 8000 ? `export-${i}` : "";
    return `WEIGHT,${value},kg,${at},,${note},${externalId}`;
  });
}

function csvRequest(lines: string[]): NextRequest {
  return new NextRequest("http://localhost/api/import/csv", {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body: [HEADER, ...lines].join("\n"),
  });
}

interface CsvEnvelope {
  data: {
    inserted: number;
    updated: number;
    skipped: number;
    total: number;
  } | null;
}

async function signIn() {
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: "csv-reimport",
      email: "csv-reimport@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await getPrismaClient().session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
});

describe("POST /api/import/csv — re-importing a 9 000-row file (real Postgres)", () => {
  it("imports once, writes nothing the second time, and updates only what changed", async () => {
    await signIn();
    const { POST } = await import("@/app/api/import/csv/route");
    const prisma = getPrismaClient();

    const first = await POST(csvRequest(fileLines()));
    expect(first.status).toBe(200);
    expect(((await first.json()) as CsvEnvelope).data).toMatchObject({
      inserted: ROWS,
      updated: 0,
      skipped: 0,
    });
    expect(await prisma.measurement.count({ where: { userId: USER } })).toBe(
      ROWS,
    );
    const before = await prisma.measurement.findMany({
      where: { userId: USER },
      select: { id: true, value: true, notesEncrypted: true },
      orderBy: { measuredAt: "asc" },
    });

    const second = await POST(csvRequest(fileLines()));
    expect(second.status).toBe(200);
    expect(((await second.json()) as CsvEnvelope).data).toMatchObject({
      inserted: 0,
      updated: 0,
      skipped: ROWS,
    });
    const after = await prisma.measurement.findMany({
      where: { userId: USER },
      select: { id: true, value: true, notesEncrypted: true },
      orderBy: { measuredAt: "asc" },
    });
    // Same rows, untouched: not even the note ciphertext was re-sealed.
    expect(after).toEqual(before);

    const changed = new Set([0, 1, 4999, 7999]);
    const third = await POST(csvRequest(fileLines(changed)));
    expect(third.status).toBe(200);
    expect(((await third.json()) as CsvEnvelope).data).toMatchObject({
      inserted: 0,
      updated: changed.size,
      skipped: ROWS - changed.size,
    });
    expect(await prisma.measurement.count({ where: { userId: USER } })).toBe(
      ROWS,
    );
    const edited = await prisma.measurement.findFirst({
      where: { userId: USER, externalId: "export-4999" },
      select: { value: true },
    });
    expect(edited?.value).toBeCloseTo(70 + (4999 % 50) / 10 + 1, 5);
  }, 120_000);
});
