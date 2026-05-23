/**
 * Unit coverage for the v1.4.48 M1 worker-boot probe that flags
 * legacy `integration_statuses` rows whose JSON failure bucket is
 * still NULL.
 *
 * The contract under test:
 *   - emits a single `prisma.integrationStatus.count` against the
 *     `consecutiveFailuresByKind: { equals: null }` predicate;
 *   - when the count is > 0, the wrapping Wide Event is elevated to
 *     `warn` and the count is annotated under
 *     `meta.integration_status_null_buckets`;
 *   - when the count is 0, the event stays at `info` and no warning
 *     is added.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { WideEventBuilder } from "@/lib/logging/event-builder";
import { eventStorage } from "@/lib/logging/context";
import { probeIntegrationStatusNullBuckets } from "../integration-status-null-probe";

function makePrismaMock(count: number) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ count: BigInt(count) }]),
  } as unknown as PrismaClient;
}

async function runWithEvent<T>(
  fn: (evt: WideEventBuilder) => Promise<T>,
): Promise<{ evt: WideEventBuilder; value: T }> {
  const evt = new WideEventBuilder("background");
  const value = await eventStorage.run(evt, () => fn(evt));
  return { evt, value };
}

describe("probeIntegrationStatusNullBuckets", () => {
  it("queries with the right predicate and returns the count", async () => {
    const prisma = makePrismaMock(3);
    const { value } = await runWithEvent(() =>
      probeIntegrationStatusNullBuckets(prisma),
    );

    expect(value).toEqual({ count: 3 });
    const queryRaw = prisma.$queryRaw as ReturnType<typeof vi.fn>;
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = (queryRaw.mock.calls[0][0] as TemplateStringsArray).join("");
    expect(sql).toMatch(/consecutive_failures_by_kind\s+IS\s+NULL/i);
    expect(sql).toMatch(/integration_statuses/);
  });

  it("elevates the event to warn and annotates the count when > 0", async () => {
    const prisma = makePrismaMock(2);
    const { evt } = await runWithEvent(() =>
      probeIntegrationStatusNullBuckets(prisma),
    );
    evt.finish();
    const json = evt.toJSON();

    expect(json.level).toBe("warn");
    expect(json.warnings?.[0]).toMatch(/2 row\(s\) still carry consecutiveFailuresByKind=NULL/);
    expect(json.meta?.integration_status_null_buckets).toBe(2);
  });

  it("stays at info and emits no warning when count is 0", async () => {
    const prisma = makePrismaMock(0);
    const { evt } = await runWithEvent(() =>
      probeIntegrationStatusNullBuckets(prisma),
    );
    evt.finish();
    const json = evt.toJSON();

    expect(json.level).toBe("info");
    expect(json.warnings).toBeUndefined();
    expect(json.meta?.integration_status_null_buckets).toBeUndefined();
  });
});
