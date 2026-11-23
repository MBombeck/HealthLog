/**
 * Which page of a capped pass this tick serves.
 *
 * A periodic pass that takes the first N rows of a stable order serves the
 * same N rows on every tick, and row N + 1 never. The pass serves page
 * `tick mod pages` instead, where `tick` counts periods since the epoch: with
 * P pages every eligible row is served at least once in any P consecutive
 * ticks, with no state to keep and the same answer on every instance.
 * Rows joining or leaving between ticks shift the pages by at most that
 * many rows, which a later tick covers.
 */
export function passPageOffset(input: {
  total: number;
  pageSize: number;
  now: Date;
  periodMs: number;
}): number {
  const { total, pageSize, now, periodMs } = input;
  if (total <= pageSize) return 0;
  const pages = Math.ceil(total / pageSize);
  const tick = Math.floor(now.getTime() / periodMs);
  return (tick % pages) * pageSize;
}
