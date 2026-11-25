/**
 * Whether a device's push-to-start token can still start a Live Activity
 * over the relay. Read by the start itself (`live-activity.ts`) and by the
 * admin diagnostic's `liveActivityStart` (`diagnostics.ts`), so the two never
 * differ. Kept apart from the sender so reading it starts nothing.
 */

/** The relay's window for a start statement, less five minutes of margin. */
const START_STATEMENT_MAX_AGE_S = 30 * 24 * 3600 - 300;

/** The `iat` (unix seconds) of a device statement, or null. */
export function statementIat(statement: unknown): number | null {
  const iat = (statement as { iat?: unknown } | null)?.iat;
  return typeof iat === "number" ? iat : null;
}

/**
 * Whether the device holds a push-to-start token the relay still takes: the
 * token, its signature, and a statement young enough.
 */
export function laStartTokenUsable(
  device: {
    laStartToken: string | null;
    laStartSignature: string | null;
    laStartStatement: unknown;
  },
  now: Date,
): boolean {
  const iat = statementIat(device.laStartStatement);
  return (
    !!device.laStartToken &&
    !!device.laStartSignature &&
    iat !== null &&
    Math.floor(now.getTime() / 1000) - iat <= START_STATEMENT_MAX_AGE_S
  );
}
