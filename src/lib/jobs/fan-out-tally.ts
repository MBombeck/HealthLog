/**
 * The per-item count of a fan-out pass, for the run's outcome.
 *
 * A pass over many devices, accounts or sources catches a failed item, logs a
 * warning and carries on, which is right: one device's refused push must not
 * retry the whole cohort. It used to end there, with `jobDone` and counts of
 * what worked, so the run read as green on the admin page however many items
 * failed, and the warning lived only in a log nobody was reading.
 *
 * A tally counts every item the pass attempted and every one it caught a
 * failure for. The handler writes both into its facts with `partial_failed`
 * (at least one item failed and the run still completed), and the failing
 * jobs card (`readFailingQueues`) lists such a run beside the ones that
 * threw, with the counts in words. It is not a failure of the queue: the
 * repeated-failure alert does not count it, and pg-boss does not retry it.
 *
 * Items a gate skipped (no consent, nothing due, module off) are not
 * attempted. A failure that is already on the person's own surface (an
 * integration source's outcome, a report schedule's status) is counted too:
 * it says the host could not do the work, which is the operator's question.
 */
export class FanOutTally {
  attempted = 0;
  failed = 0;

  /** One item the pass attempted and finished. */
  ok(): void {
    this.attempted += 1;
  }

  /** One item whose failure the pass caught and carried on past. */
  fail(): void {
    this.attempted += 1;
    this.failed += 1;
  }

  /** At least one item failed and the run completed: the card lists it. */
  get partialFailed(): boolean {
    return this.failed > 0;
  }
}
