/**
 * Transaction-client stubs for `adoptOrMintHourlyRows`, shared by the mocked
 * dense-tier fold tests.
 *
 * The hourly mint reads the day's candidate rows with one `findMany` and
 * writes its mints with one `createManyAndReturn`. The tests were written
 * against the per-slot loop and assert on individual `create` calls, so the
 * batch insert here is routed through the test's own `create` spy, one call
 * per minted row: the assertions keep reading what was minted, in slot order.
 */
import { vi } from "vitest";

type CreateSpy = (args: {
  data: { externalId: string };
}) => Promise<{ id: string }>;

/** `createManyAndReturn` that forwards every row to `create`. */
export function createManyVia(create: CreateSpy) {
  return vi.fn(async (args: { data: Array<{ externalId: string }> }) => {
    const out: Array<{ id: string; externalId: string }> = [];
    for (const data of args.data) {
      const row = await create({ data });
      out.push({ id: row.id, externalId: data.externalId });
    }
    return out;
  });
}

/**
 * The day's candidate lookup. With `existingId`, one row already occupies the
 * first slot's anchor instant (the adopt-in-place case); otherwise nothing is
 * in the way.
 */
export function candidateLookup(existingId: string | null = null) {
  return vi.fn(
    async (args: {
      where: { OR: [unknown, { measuredAt: { in: Date[] } }] };
    }) =>
      existingId === null
        ? []
        : [
            {
              id: existingId,
              externalId: null,
              measuredAt: args.where.OR[1].measuredAt.in[0]!,
            },
          ],
  );
}
