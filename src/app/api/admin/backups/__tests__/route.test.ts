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
 * worker holds no listing grant on the bucket still gets a true answer.
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
          lastAttemptAt: new Date(now - 3 * HOUR),
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
          lastAttemptAt: new Date(now - 31 * HOUR),
          lastSuccessAt: new Date(now - 31 * HOUR),
          sizeBytes: BigInt(8192),
        },
      },
      {
        id: "u3",
        username: "account-three",
        offhostBackupState: {
          lastAttemptAt: new Date(now - 100 * HOUR),
          lastSuccessAt: new Date(now - 100 * HOUR),
          sizeBytes: BigInt(128),
        },
      },
      {
        id: "u4",
        username: "account-four",
        // Walked by a run, nothing landed.
        offhostBackupState: {
          lastAttemptAt: new Date(now - 2 * HOUR),
          lastSuccessAt: null,
          sizeBytes: null,
        },
      },
      // No run has recorded this one at all — the state of every account on
      // the morning the ledger ships.
      { id: "u5", username: "account-five", offhostBackupState: null },
    ]);

    const body = await read();

    expect(body.offhost.configured).toBe(true);
    expect(body.offhost.periodHours).toBe(24);
    // Worst first, alphabetical within a verdict. The database hands them
    // back by username; the one account that needs attention must not be
    // wherever the alphabet leaves it on a hundred-account cohort.
    expect(
      body.offhost.rows.map((row) => [row.username, row.freshness]),
    ).toEqual([
      ["account-three", "stale"],
      ["account-two", "due"],
      ["account-four", "never"],
      ["account-five", "unknown"],
      ["account-one", "fresh"],
    ]);
    const byName = new Map(body.offhost.rows.map((row) => [row.username, row]));
    expect(byName.get("account-one")?.sizeBytes).toBe(4096);
    expect(typeof byName.get("account-one")?.sizeBytes).toBe("number");
    expect(byName.get("account-one")?.ageHours).toBe(3);
    expect(byName.get("account-four")?.lastSuccessAt).toBeNull();
    expect(byName.get("account-four")?.sizeBytes).toBeNull();
    expect(byName.get("account-four")?.lastAttemptAt).not.toBeNull();
    // `unknown` is the honest one: the ledger has no history for this
    // account, which is not the same claim as "the bucket is empty".
    expect(byName.get("account-five")?.lastAttemptAt).toBeNull();
  });

  it("says so when neither the environment nor the ledger knows of any upload", async () => {
    configuredMock.mockReturnValue(false);
    findManyMock.mockResolvedValue([
      { id: "u1", username: "account-one", offhostBackupState: null },
    ]);

    const body = await read();

    expect(body.offhost).toEqual({
      configured: false,
      periodHours: 24,
      rows: [],
    });
  });

  it("lets a ledger row outrank this process's own environment", async () => {
    // A hand-rolled split deployment can give BACKUP_S3_* to the worker and
    // not to the web process. The rows are proof uploads are happening;
    // saying "nothing leaves this host" over them would be this process
    // reporting on a job it cannot see.
    configuredMock.mockReturnValue(false);
    findManyMock.mockResolvedValue([
      {
        id: "u1",
        username: "account-one",
        offhostBackupState: {
          lastAttemptAt: new Date(),
          lastSuccessAt: new Date(),
          sizeBytes: BigInt(4096),
        },
      },
    ]);

    const body = await read();

    expect(body.offhost.configured).toBe(true);
    expect(body.offhost.rows.map((row) => row.freshness)).toEqual(["fresh"]);
  });

  it("never ships a credential or an object key with the verdicts", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "u1",
        username: "account-one",
        offhostBackupState: {
          lastAttemptAt: new Date(),
          lastSuccessAt: new Date(),
          sizeBytes: BigInt(1),
        },
      },
    ]);

    const body = await read();

    expect(Object.keys(body.offhost.rows[0] ?? {}).sort()).toEqual([
      "ageHours",
      "freshness",
      "lastAttemptAt",
      "lastSuccessAt",
      "sizeBytes",
      "userId",
      "username",
    ]);
    expect(JSON.stringify(body.offhost)).not.toMatch(/bucket|endpoint|secret/i);
  });
});
