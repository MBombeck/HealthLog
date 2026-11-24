/**
 * A record-file import that stops on an unexpected error stores a closed
 * reason on its job row, never the error's own text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updates = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const thrown = vi.hoisted(() => ({ error: new Error("boom") as unknown }));

vi.mock("@/lib/db", () => ({
  prisma: {
    importJob: {
      findUnique: vi.fn(async () => ({
        status: "queued",
        userId: "u1",
        kind: "fhir_bundle",
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      }),
    },
  },
  toJson: (v: unknown) => v,
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "UTC"),
}));
vi.mock("@/lib/jobs/import-tail", () => ({
  afterBulkImport: vi.fn(async () => ({ rollupFailed: false })),
}));
vi.mock("@/lib/import/fhir-bundle/import", () => ({
  importFhirBundleFile: vi.fn(async () => {
    throw thrown.error;
  }),
}));

import { RecordFileImportError } from "@/lib/import/file-import/kinds";
import { runRecordFileImport } from "../record-file-import-worker";

const payload = {
  kind: "fhir_bundle" as const,
  userId: "u1",
  importJobId: "j1",
  uploadPath: "/nonexistent/record-file-import-test.bin",
};

beforeEach(() => {
  updates.length = 0;
});

describe("record-file import failure reason", () => {
  it("stores a closed reason for an unexpected error", async () => {
    thrown.error = new RangeError(
      'Invalid `prisma.encounter.create()` invocation: value "secret"',
    );
    await runRecordFileImport(payload);
    const failed = updates.find((u) => u.status === "failed");
    expect(failed?.failureReason).toMatch(/^import_failed: /);
    expect(String(failed?.failureReason)).not.toContain("prisma");
  });

  it("keeps the refusal's own closed reason", async () => {
    thrown.error = new RecordFileImportError(
      "not_fhir_bundle",
      "the file is not a FHIR Bundle",
    );
    await runRecordFileImport(payload);
    const failed = updates.find((u) => u.status === "failed");
    expect(failed?.failureReason).toMatch(/^not_fhir_bundle:/);
  });
});
