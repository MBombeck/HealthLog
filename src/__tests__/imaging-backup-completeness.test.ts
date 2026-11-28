/**
 * Pair guard binding `prisma/schema.prisma`'s `ImagingExam` and
 * `ImagingExamDocumentLink` models to the backup, through both ends.
 *
 * The sibling of `measurement-backup-completeness.test.ts` and
 * `mood-backup-completeness.test.ts`, but it proves the round trip by running
 * it rather than by matching source text: every scalar column of the schema
 * block is seeded with a distinct value, the row goes through
 * `buildImagingBackupSection` (disaster-recovery and portable) and the payload
 * schema, and `restoreImagingData` must write each column back with the value
 * it started with. A column added to the model and not carried shows up here
 * by name, in either format.
 *
 * Mutation check: drop `conclusion` from `TEXT_FIELDS` in
 * `src/lib/export/imaging-backup.ts`, or the `side:` line in its restore, and
 * this goes red naming the column.
 */
import { describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  buildImagingBackupSection,
  restoreImagingData,
} from "@/lib/export/imaging-backup";
import type { RestoreSkipLog } from "@/lib/export/restore-skips";
import { parseBackupPayload } from "@/lib/validations/backup";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { readSource } from "./helpers/source-files";

const SCHEMA = readSource("prisma/schema.prisma", [
  "model ImagingExam {",
  "model ImagingExamDocumentLink {",
]);

/** Columns the backup is right to leave out, each with its reason. */
const EXCLUDED: Record<string, Record<string, string>> = {
  ImagingExam: {
    userId: "user-scoped backup; the owner is the restoring account",
  },
  ImagingExamDocumentLink: {
    id: "a link row's own id carries nothing; the pair is the identity",
    userId: "user-scoped backup; the owner is the restoring account",
  },
};

function scalarFields(model: string): Array<{ name: string; type: string }> {
  const start = SCHEMA.indexOf(`model ${model} {`);
  expect(start, `model ${model} not found`).toBeGreaterThan(-1);
  const block = SCHEMA.slice(start, SCHEMA.indexOf("\n}", start));
  const models = new Set(
    [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]),
  );
  const out: Array<{ name: string; type: string }> = [];
  for (const raw of block.split("\n").slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    const m = /^(\w+)\s+(\w+)(\[\])?/.exec(line);
    if (!m || m[3] || models.has(m[2]) || line.includes("@relation")) continue;
    out.push({ name: m[1], type: m[2] });
  }
  expect(out.length).toBeGreaterThan(3);
  return out;
}

const ENUM_VALUE: Record<string, string> = {
  ImagingModality: "ULTRASOUND",
  ImagingSide: "BOTH",
};

/** A distinct, non-default value per column. */
function seedRow(model: string): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  scalarFields(model).forEach(({ name, type }, i) => {
    if (type === "String") row[name] = `${name}-value`;
    else if (type === "DateTime")
      row[name] = new Date(Date.UTC(2025, 0, 2 + i));
    else if (type === "Bytes") row[name] = encryptToBytes(`${name} text`);
    else if (type in ENUM_VALUE) row[name] = ENUM_VALUE[type];
    else throw new Error(`no seed for ${model}.${name}: ${type}`);
  });
  return row;
}

function comparable(value: unknown): unknown {
  if (value instanceof Uint8Array) return decryptFromBytes(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

async function roundTrip(purpose: "disaster-recovery" | "portable-export") {
  const exam = seedRow("ImagingExam");
  const link = {
    ...seedRow("ImagingExamDocumentLink"),
    examId: exam.id,
    documentId: "doc-1",
  };
  const source = {
    imagingExam: { findMany: vi.fn().mockResolvedValue([exam]) },
    imagingExamDocumentLink: { findMany: vi.fn().mockResolvedValue([link]) },
  };
  const section = await buildImagingBackupSection(
    source as unknown as Pick<
      PrismaClient,
      "imagingExam" | "imagingExamDocumentLink"
    >,
    "owner",
    {
      purpose,
    },
  );
  const parsed = parseBackupPayload({
    schemaVersion: "2",
    exportedAt: new Date().toISOString(),
    userId: "owner",
    ...section,
  });

  const writes: Record<string, Array<Record<string, unknown>>> = {};
  const capture =
    (model: string) =>
    async ({ data }: { data: Array<Record<string, unknown>> }) => {
      writes[model] = data;
      return { count: data.length };
    };
  const tx = {
    imagingExam: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: capture("ImagingExam"),
    },
    imagingExamDocumentLink: { createMany: capture("ImagingExamDocumentLink") },
    inboundDocument: {
      findMany: vi.fn().mockResolvedValue([{ id: "doc-1" }]),
    },
  };
  const skips: RestoreSkipLog = [];
  await restoreImagingData(
    tx as unknown as Prisma.TransactionClient,
    "owner",
    parsed,
    skips,
  );
  expect(skips).toEqual([]);
  return { exam, link, writes };
}

describe.each(["disaster-recovery", "portable-export"] as const)(
  "imaging backup completeness (%s)",
  (purpose) => {
    it.each(["ImagingExam", "ImagingExamDocumentLink"])(
      "restores every %s column with the value it left with",
      async (model) => {
        const { exam, link, writes } = await roundTrip(purpose);
        const original: Record<string, unknown> =
          model === "ImagingExam" ? exam : link;
        const written = writes[model]?.[0];
        expect(written, `${model} was not written`).toBeDefined();
        const missing: string[] = [];
        for (const { name } of scalarFields(model)) {
          if (name in EXCLUDED[model]) continue;
          if (comparable(written![name]) !== comparable(original[name])) {
            missing.push(name);
          }
        }
        expect(missing).toEqual([]);
      },
    );
  },
);

describe("imaging backup exclusions", () => {
  it("gives every excluded column a reason and names a real column", () => {
    for (const [model, columns] of Object.entries(EXCLUDED)) {
      const names = new Set(scalarFields(model).map((f) => f.name));
      for (const [column, reason] of Object.entries(columns)) {
        expect(names.has(column), `${model}.${column}`).toBe(true);
        expect(reason.length).toBeGreaterThan(20);
      }
    }
  });
});
