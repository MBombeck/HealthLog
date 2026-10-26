/**
 * A lifecycle read that fails once does not undo what the bucket said an
 * hour before. Read as "unknown", it kept every key an off-host object ever
 * needed in the recovery kit, the kit turned due and the admins were pushed,
 * and the next good read pushed "recovered".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIFECYCLE_UNKNOWN,
  type OffhostLifecycle,
} from "@/lib/jobs/offhost-lifecycle";
import { probeOffhostLifecycle, type S3Like } from "@/lib/jobs/offhost-backup";

const CONFIGURED: OffhostLifecycle = {
  state: "configured",
  expirationDays: 30,
  database: { state: "configured", expirationDays: 30 },
};
const bucket = (answer: () => Promise<OffhostLifecycle>) =>
  ({ getLifecycle: answer }) as unknown as S3Like;

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-25T00:00:00Z");

beforeEach(() => {
  vi.stubEnv("BACKUP_S3_ENDPOINT", "https://bucket.example");
  vi.stubEnv("BACKUP_S3_BUCKET", "b");
  vi.stubEnv("BACKUP_S3_ACCESS_KEY", "a");
  vi.stubEnv("BACKUP_S3_SECRET_KEY", "s");
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", "e".repeat(64));
});
afterEach(() => vi.unstubAllEnvs());

describe("the bucket's lifecycle rule, read again", () => {
  it("keeps the last answer the bucket gave through a failed read, for a day", async () => {
    expect(
      await probeOffhostLifecycle(
        bucket(async () => CONFIGURED),
        T0,
      ),
    ).toEqual(CONFIGURED);
    const failing = bucket(async () => LIFECYCLE_UNKNOWN);
    expect(await probeOffhostLifecycle(failing, T0 + HOUR)).toEqual(CONFIGURED);
    const thrown = bucket(async () => {
      throw new Error("ETIMEDOUT");
    });
    expect(await probeOffhostLifecycle(thrown, T0 + 2 * HOUR)).toEqual(
      CONFIGURED,
    );
    // A day without a single good read is an answer of its own.
    expect(await probeOffhostLifecycle(failing, T0 + 25 * HOUR)).toEqual(
      LIFECYCLE_UNKNOWN,
    );
  });
});
