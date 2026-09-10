/**
 * `GET /api/admin/backups` — the off-host leg.
 *
 * The rows the weekly pass writes into this database were already covered by
 * the page that lists them. What was not covered is the question this response
 * now answers: per account, when did an encrypted copy last reach the
 * operator's bucket, and is that inside what the nightly schedule promises.
 *
 * The bucket is never touched here, and that is the assertion that matters —
 * the verdicts come from the ledger the worker writes, so an operator whose
 * worker holds PutObject and nothing else still gets a true answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAdmin: vi.fn(async () => ({ user: { id: "admin-1" } })),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/jobs/job-failures", () => ({
  readLastQueueRun: vi.fn(async () => null),
}));

const queryRawMock = vi.fn();
const findManyMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: (...a: unknown[]) => queryRawMock(...a),
    user: { findMany: (...a: unknown[]) => findManyMock(...a) },
  },
}));

const configuredMock = vi.fn(() => true);
vi.mock("@/lib/jobs/offhost-backup", () => ({
  offhostBackupConfigured: () => configuredMock(),
}));

import { GET } from "../route";
import type { BackupsList } from "@/types/backups";

const HOUR = 3_600_000;

async function read(): Promise<BackupsList> {
  const res = await (GET as unknown as () => Promise<Response>)();
  expect(res.status).toBe(200);
  return (await res.json()).data as BackupsList;
}

beforeEach(() => {
  vi.clearAllMocks();
  configuredMock.mockReturnValue(true);
  queryRawMock.mockResolvedValue([]);
  findManyMock.mockResolvedValue([]);
});

describe("GET /api/admin/backups — off-host freshness", () => {
  it("rates every account against the nightly schedule without listing the bucket", async () => {
    const now = Date.now();
    findManyMock.mockResolvedValue([
      {
        id: "u1",
        username: "account-one",
        offhostBackupState: {
          lastSuccessAt: new Date(now - 3 * HOUR),
          // The column is BigInt — an object may be 80 GB — and the wire type
          // is a plain number.
          sizeBytes: BigInt(4096),
        },
      },
      {
        id: "u2",
        username: "account-two",
        offhostBackupState: {
          lastSuccessAt: new Date(now - 30 * HOUR),
          sizeBytes: BigInt(8192),
        },
      },
      {
        id: "u3",
        username: "account-three",
        offhostBackupState: {
          lastSuccessAt: new Date(now - 100 * HOUR),
          sizeBytes: BigInt(128),
        },
      },
      { id: "u4", username: "account-four", offhostBackupState: null },
    ]);

    const body = await read();

    expect(body.offhost.configured).toBe(true);
    expect(body.offhost.periodHours).toBe(24);
    expect(
      body.offhost.rows.map((row) => [row.username, row.freshness]),
    ).toEqual([
      ["account-one", "fresh"],
      ["account-two", "due"],
      ["account-three", "stale"],
      ["account-four", "never"],
    ]);
    expect(body.offhost.rows[0]?.sizeBytes).toBe(4096);
    expect(typeof body.offhost.rows[0]?.sizeBytes).toBe("number");
    expect(body.offhost.rows[0]?.ageHours).toBe(3);
    expect(body.offhost.rows[3]?.lastSuccessAt).toBeNull();
    expect(body.offhost.rows[3]?.sizeBytes).toBeNull();
  });

  it("says so and reads no account when off-host backup is not configured", async () => {
    configuredMock.mockReturnValue(false);

    const body = await read();

    expect(body.offhost).toEqual({
      configured: false,
      periodHours: 24,
      rows: [],
    });
    // Not merely empty output — the query never runs, so an unconfigured host
    // does not pay for a table scan to be told nothing is set up.
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("never ships a credential or an object key with the verdicts", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "u1",
        username: "account-one",
        offhostBackupState: {
          lastSuccessAt: new Date(),
          sizeBytes: BigInt(1),
        },
      },
    ]);

    const body = await read();

    expect(Object.keys(body.offhost.rows[0] ?? {}).sort()).toEqual([
      "ageHours",
      "freshness",
      "lastSuccessAt",
      "sizeBytes",
      "userId",
      "username",
    ]);
    expect(JSON.stringify(body.offhost)).not.toMatch(/bucket|endpoint|secret/i);
  });
});
