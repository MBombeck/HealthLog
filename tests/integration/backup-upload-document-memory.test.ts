/**
 * An uploaded backup with a large document vault, checked under a memory
 * budget (#1239).
 *
 * What this pins. The upload route streamed the measurements while it checked
 * a file and read every other section whole: the scanner gathered the
 * `documents` member as one string and parsed it in one go. A copy of an
 * account whose documents carry a few hundred megabytes of base64 then cost
 * the text of the section plus its parse, more than the 524 MB heap of a 1 GB
 * container, and the process was killed in the middle of the upload. The
 * weekly copy and the restore had stopped doing that already; the upload had
 * its own section list. It now reads through the shared streamed reader,
 * which takes the documents one at a time and keeps them without their bytes.
 *
 * How it measures. The file is written to disk a document at a time and sent
 * to the real route handler as a streamed request body, as an admin with a
 * cookie session. Readings are taken from inside that body, every few
 * chunks, after a forced collection, so what is compared is what the route
 * HOLDS while it reads. The documents come first in the file and a few
 * megabytes of readings after them, so there are readings taken once the
 * whole vault has gone past: a route that kept the vault holds it there.
 *
 * Measured on this fixture: the route that read the documents whole held
 * about 270 MB once they had gone past (the parsed base64), and run under
 * `--max-old-space-size=524` it ran out of heap; the streamed route holds a
 * few megabytes. Run it under that flag for the production ceiling:
 * `NODE_OPTIONS=--max-old-space-size=524`.
 */
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import v8 from "node:v8";
import vm from "node:vm";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const prisma = getPrismaClient();

/** A hundred documents of 2.75 MiB of base64 each: about 275 MB of vault. */
const DOCUMENTS = 100;
const DOCUMENT_BYTES = 2 * 1024 * 1024;
/** Readings after the vault, so the route is sampled once it has gone past. */
const MEASUREMENTS = 30_000;
/** Take a reading every this many chunks of the request body. */
const SAMPLE_EVERY_CHUNKS = 8;

/**
 * What the route may hold on top of the process's baseline while it reads
 * the file. Measured: a few megabytes when the documents are streamed, about
 * 270 MB when the section is read whole. The bound sits far from both.
 */
const HELD_BUDGET_BYTES = 48 * 1024 * 1024;

const forceGc = ((): (() => void) => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return gc;
})();

function liveHeapBytes(): number {
  forceGc();
  forceGc();
  return process.memoryUsage().heapUsed;
}

const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

let directory = "";
let filePath = "";
let fileBytes = 0;
/** Where the documents section ends in the file, in bytes. */
let vaultEndsAt = 0;
let adminId = "";

/** Write one piece of the file, waiting when the stream asks for it. */
async function put(
  out: ReturnType<typeof createWriteStream>,
  text: string,
): Promise<void> {
  if (!out.write(text)) await once(out, "drain");
}

/**
 * The backup file, written a piece at a time so the test never holds it: the
 * documents first, each carrying the same real document ciphertext (the key
 * check reads its key id), then the readings.
 */
async function writeBackupFile(ownerId: string): Promise<void> {
  const { encryptDocumentContent } = await import("@/lib/documents/store");
  const { BACKUP_SCHEMA_VERSION } =
    await import("@/lib/validations/backup-summary");
  const { content, codec } = encryptDocumentContent(
    randomBytes(DOCUMENT_BYTES),
  );
  const base64 = Buffer.from(content).toString("base64");

  const out = createWriteStream(filePath);
  let written = 0;
  const write = async (text: string) => {
    written += Buffer.byteLength(text);
    await put(out, text);
  };
  const head = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: "2026-10-01T10:00:00.000Z",
    userId: ownerId,
    medications: [],
    intakeEvents: [],
    moodEntries: [],
  };
  await write(JSON.stringify(head).slice(0, -1));
  await write(',"documents":[');
  for (let i = 0; i < DOCUMENTS; i++) {
    const document = {
      id: `upload-memory-doc-${i}`,
      kind: "DOCTOR_REPORT",
      title: `Report ${i}`,
      filename: `report-${i}.pdf`,
      mimeType: "application/pdf",
      byteSize: content.byteLength,
      status: "STORED",
      contentEncrypted: base64,
      contentCodec: codec,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await write((i === 0 ? "" : ",") + JSON.stringify(document));
  }
  await write("]");
  vaultEndsAt = written;
  await write(',"measurements":[');
  for (let i = 0; i < MEASUREMENTS; i++) {
    const reading = {
      id: `upload-memory-reading-${i}`,
      type: "WEIGHT",
      value: 80 + (i % 10) / 10,
      unit: "kg",
      measuredAt: new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toISOString(),
      source: "MANUAL",
      notes: null,
    };
    await write((i === 0 ? "" : ",") + JSON.stringify(reading));
  }
  await write("]}");
  out.end();
  await once(out, "finish");
  fileBytes = (await stat(filePath)).size;
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  const admin = await prisma.user.create({
    data: {
      username: "upload-memory-admin",
      email: "upload-memory-admin@example.test",
      role: "ADMIN",
    },
  });
  adminId = admin.id;
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);

  directory = await mkdtemp(join(tmpdir(), "backup-upload-memory-"));
  filePath = join(directory, "backup.json");
  await writeBackupFile(admin.id);
}, 240_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  await truncateAllTables(prisma);
});

describe("backup upload of a document vault under a memory budget", () => {
  it("holds a bounded amount while it checks and stores the file", async () => {
    expect(fileBytes).toBeGreaterThan(DOCUMENTS * DOCUMENT_BYTES);

    const { POST } = await import("@/app/api/admin/backups/upload/route");
    // Modules loaded once per process, not memory that grows with the file:
    // loaded before the baseline, as a running server has long since done.
    await import("@/lib/validations/backup");
    const baseline = liveHeapBytes();

    let bytesSent = 0;
    let chunks = 0;
    let peakHeld = 0;
    let samplesPastVault = 0;
    let peakPastVault = 0;
    async function* body(): AsyncGenerator<Buffer> {
      for await (const chunk of createReadStream(filePath)) {
        const buffer = chunk as Buffer;
        bytesSent += buffer.byteLength;
        if (chunks++ % SAMPLE_EVERY_CHUNKS === 0) {
          const held = liveHeapBytes() - baseline;
          peakHeld = Math.max(peakHeld, held);
          // The route has had the whole vault once it asks for the chunk
          // after the one that closed it.
          if (bytesSent - buffer.byteLength > vaultEndsAt) {
            samplesPastVault++;
            peakPastVault = Math.max(peakPastVault, held);
          }
        }
        yield buffer;
      }
    }

    const request = new Request("http://localhost/api/admin/backups/upload", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(fileBytes),
      },
      body: Readable.toWeb(Readable.from(body())) as ReadableStream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const res = await POST(request as unknown as Parameters<typeof POST>[0]);
    peakHeld = Math.max(peakHeld, liveHeapBytes() - baseline);

    process.stderr.write(
      `[upload-document-memory] ${mb(fileBytes)} MB file, ${DOCUMENTS} documents: ` +
        `peak held ${mb(peakHeld)} MB, past the vault ${mb(peakPastVault)} MB ` +
        `(${samplesPastVault} samples), ` +
        `${mb(v8.getHeapStatistics().heap_size_limit)} MB heap limit\n`,
    );

    const answer = (await res.json()) as {
      data: { id: string; summary: Record<string, unknown> } | null;
      error: string | null;
    };
    expect(res.status, JSON.stringify(answer.error)).toBe(201);
    expect(answer.data!.summary).toMatchObject({
      documents: DOCUMENTS,
      measurements: MEASUREMENTS,
    });
    const row = await prisma.dataBackup.findUniqueOrThrow({
      where: { id: answer.data!.id },
      select: { userId: true, type: true },
    });
    expect(row.userId).toBe(adminId);
    expect(row.type).toMatch(/^MANUAL_UPLOAD_\d+$/);

    // Not vacuous: the whole file went through the route, and the route was
    // sampled after the vault had gone past it.
    expect(bytesSent).toBe(fileBytes);
    expect(samplesPastVault).toBeGreaterThan(3);
    expect(
      peakHeld,
      `the upload held ${mb(peakHeld)} MB of a ${mb(fileBytes)} MB file`,
    ).toBeLessThan(HELD_BUDGET_BYTES);
  }, 600_000);
});
