/**
 * One plain line for the operator, on stdout.
 *
 * The production build strips `console.log`, `console.info` and
 * `console.debug` (`compiler.removeConsole` in `next.config.ts`, which keeps
 * only `error` and `warn`), so a notice written with one of those is in the
 * development log and nowhere else. The setup token for a fresh install was
 * one of them: the line the getting-started guide tells an operator to grep
 * for never reached a production container's log. A direct write to stdout is
 * not a `console` call and survives the build; `operator-line-guard.test.ts`
 * fails on any stripped `console` call left under `src/`.
 *
 * Plain text rather than a wide event: these lines are read by a person with
 * `docker compose logs app | grep`, and a wide event would put the value
 * through the payload redaction that exists to keep secrets out of logs.
 */
export function operatorLine(line: string): void {
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // A notice must never break the caller.
  }
}
