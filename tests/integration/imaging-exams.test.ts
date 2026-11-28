/**
 * Imaging exams (#1672) through the real routes and a real Postgres.
 *
 * Pinned here: an exam is created with its text sealed at rest and its vault
 * documents filed; another account's document id is dropped, never filed; the
 * list and detail answer only to the owner; a partial edit clears a text and
 * replaces the documents; the delete removes the exam and its links, keeps
 * the documents and writes the audit row; and the body cannot carry a userId.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { GET as listExams, POST as createExam } from "@/app/api/imaging/route";
import {
  DELETE as deleteExam,
  GET as readExam,
  PATCH as patchExam,
} from "@/app/api/imaging/[id]/route";

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

let sequence = 0;

async function person(label: string) {
  const suffix = sequence++;
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return { id: user.id, sessionId: session.id };
}

function signIn(who: { sessionId: string }) {
  headerJar.delete("authorization");
  cookieJar.set("healthlog_session", who.sessionId);
}

async function vaultDocument(userId: string, title: string) {
  return getPrismaClient().inboundDocument.create({
    data: {
      userId,
      kind: "IMAGING",
      title,
      mimeType: "application/pdf",
      byteSize: 12,
      contentEncrypted: new Uint8Array([1, 2, 3]),
      contentCodec: "binary2",
      documentDate: new Date("2026-05-14T00:00:00.000Z"),
    },
  });
}

function json(method: string, url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

interface ExamDto {
  id: string;
  modality: string;
  performedAt: string;
  side: string | null;
  bodyPart: string | null;
  facility: string | null;
  requestingDoctor: string | null;
  conclusion: string | null;
  documents: Array<{ id: string; label: string | null; redacted: boolean }>;
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("imaging exams", () => {
  it("creates an exam with sealed text and its own documents only", async () => {
    const owner = await person("owner");
    const other = await person("other");
    const report = await vaultDocument(owner.id, "MRI report");
    const foreign = await vaultDocument(other.id, "Someone else's report");
    signIn(owner);

    const res = await createExam(
      json("POST", "/api/imaging", {
        modality: "MRI",
        performedAt: "2026-05-14T09:30:00.000Z",
        side: "LEFT",
        bodyPart: "  Knee ",
        facility: "Radiology on the hill",
        requestingDoctor: "the orthopaedic surgeon",
        conclusion: "Small meniscus tear",
        documentIds: [report.id, foreign.id],
        userId: other.id,
      }) as never,
    );
    expect(res.status).toBe(201);
    const exam = await data<ExamDto>(res);
    expect(exam).toMatchObject({
      modality: "MRI",
      performedAt: "2026-05-14T00:00:00.000Z",
      side: "LEFT",
      bodyPart: "Knee",
      conclusion: "Small meniscus tear",
    });
    expect(exam.documents.map((d) => d.id)).toEqual([report.id]);

    const prisma = getPrismaClient();
    const row = await prisma.imagingExam.findUniqueOrThrow({
      where: { id: exam.id },
    });
    // The owner is the session's account, whatever the body said.
    expect(row.userId).toBe(owner.id);
    // Sealed at rest: the stored bytes are not the typed text.
    expect(
      Buffer.from(row.conclusionEncrypted!).toString("utf8"),
    ).not.toContain("meniscus");
    expect(
      await prisma.imagingExamDocumentLink.count({
        where: { documentId: foreign.id },
      }),
    ).toBe(0);
  });

  it("refuses an exam without a modality or with a future day", async () => {
    signIn(await person("owner"));
    const missing = await createExam(
      json("POST", "/api/imaging", {
        performedAt: "2026-05-14T00:00:00.000Z",
      }) as never,
    );
    expect(missing.status).toBe(422);
    const future = await createExam(
      json("POST", "/api/imaging", {
        modality: "CT",
        performedAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      }) as never,
    );
    expect(future.status).toBe(422);
  });

  it("answers only to its owner", async () => {
    const owner = await person("owner");
    const other = await person("other");
    signIn(owner);
    const exam = await data<ExamDto>(
      await createExam(
        json("POST", "/api/imaging", {
          modality: "CT",
          performedAt: "2026-01-02T00:00:00.000Z",
        }) as never,
      ),
    );

    signIn(other);
    const list = await data<{ exams: ExamDto[] }>(
      await (listExams as (r: Request) => Promise<Response>)(
        json("GET", "/api/imaging"),
      ),
    );
    expect(list.exams).toEqual([]);
    for (const res of [
      await readExam(
        json("GET", `/api/imaging/${exam.id}`) as never,
        params(exam.id),
      ),
      await patchExam(
        json("PATCH", `/api/imaging/${exam.id}`, { conclusion: "x" }) as never,
        params(exam.id),
      ),
      await deleteExam(
        json("DELETE", `/api/imaging/${exam.id}`) as never,
        params(exam.id),
      ),
    ]) {
      expect(res.status).toBe(404);
    }
  });

  it("edits partially, replaces the documents and deletes with an audit row", async () => {
    const owner = await person("owner");
    const first = await vaultDocument(owner.id, "Report");
    const second = await vaultDocument(owner.id, "Images");
    signIn(owner);
    const exam = await data<ExamDto>(
      await createExam(
        json("POST", "/api/imaging", {
          modality: "ULTRASOUND",
          performedAt: "2026-03-03T00:00:00.000Z",
          bodyPart: "Abdomen",
          facility: "Practice",
          documentIds: [first.id],
        }) as never,
      ),
    );

    const edited = await data<ExamDto>(
      await patchExam(
        json("PATCH", `/api/imaging/${exam.id}`, {
          facility: "",
          side: "BOTH",
          documentIds: [second.id],
        }) as never,
        params(exam.id),
      ),
    );
    expect(edited).toMatchObject({
      bodyPart: "Abdomen",
      facility: null,
      side: "BOTH",
    });
    expect(edited.documents.map((d) => d.id)).toEqual([second.id]);

    const removed = await deleteExam(
      json("DELETE", `/api/imaging/${exam.id}`) as never,
      params(exam.id),
    );
    expect(removed.status).toBe(200);
    const prisma = getPrismaClient();
    expect(await prisma.imagingExam.count()).toBe(0);
    expect(await prisma.imagingExamDocumentLink.count()).toBe(0);
    // The documents stay in the vault.
    expect(
      await prisma.inboundDocument.count({ where: { userId: owner.id } }),
    ).toBe(2);
    const audit = await prisma.auditLog.findFirst({
      where: { userId: owner.id, action: "imaging.exam.delete" },
    });
    expect(audit).not.toBeNull();
  });
});
