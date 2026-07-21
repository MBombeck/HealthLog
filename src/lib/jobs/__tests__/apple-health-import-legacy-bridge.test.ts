import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  send: vi.fn(),
  getGlobalBoss: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    importJob: {
      findUnique: mocks.findUnique,
      update: mocks.update,
    },
  },
  toJson: (value: unknown) => value,
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: mocks.getGlobalBoss,
}));

import {
  APPLE_HEALTH_IMPORT_PARSER_REVISION,
  APPLE_HEALTH_IMPORT_SEND_OPTIONS,
  APPLE_HEALTH_IMPORT_V2_QUEUE,
  migrateLegacyAppleHealthImport,
  type AppleHealthImportPayload,
} from "../apple-health-import-worker";

const payload: AppleHealthImportPayload = {
  userId: "user-1",
  uploadPath: "/tmp/export.zip",
  uploadBytes: 100,
  enqueuedAt: "2026-07-21T10:00:00.000Z",
};

function legacyJob(): Job<AppleHealthImportPayload> {
  return {
    id: "legacy-boss-1",
    data: payload,
  } as Job<AppleHealthImportPayload>;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getGlobalBoss.mockReturnValue({ send: mocks.send });
  mocks.send.mockResolvedValue("v2-boss-1");
  mocks.findUnique.mockResolvedValue({
    id: "import-1",
    status: "queued",
    parserRevision: 1,
  });
  mocks.update.mockResolvedValue({ id: "import-1" });
});

describe("migrateLegacyAppleHealthImport", () => {
  it("moves a legacy job onto the v2 queue while preserving its mirror id", async () => {
    await migrateLegacyAppleHealthImport(legacyJob());

    expect(mocks.send).toHaveBeenCalledWith(
      APPLE_HEALTH_IMPORT_V2_QUEUE,
      payload,
      APPLE_HEALTH_IMPORT_SEND_OPTIONS,
    );
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "import-1" },
      data: {
        pgBossJobId: "v2-boss-1",
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
        status: "queued",
        failureReason: null,
        completedAt: null,
      },
    });
  });

  it("does not migrate a terminal legacy mirror", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "import-1",
      status: "done",
      parserRevision: 1,
    });

    await migrateLegacyAppleHealthImport(legacyJob());

    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
