/**
 * Wait for `work` at most `ms`, then settle with `fallback` instead.
 *
 * The budget timer is cleared as soon as either side settles. A bare
 * `Promise.race` against a `setTimeout` left the timer running after the
 * work had long answered: one live timer per server render or per audited
 * sign-in, each holding its closure until it fired. `work` is not
 * cancelled; a rejection of `work` inside the budget rejects here too.
 */
export async function settleWithin<T, F>(
  work: Promise<T>,
  ms: number,
  fallback: F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    clearTimeout(timer);
  }
}
