/**
 * Failure escalation and leg-scoped clearing on the integration ledger (real
 * Postgres).
 *
 * Two defects are pinned here, and both are about state that only exists across
 * several writes — a mocked Prisma cannot show either of them.
 *
 *   1. A `transient` streak had no exit. The park test read
 *      `kind === "persistent"` and the persistent anchor was only ever stamped
 *      by a persistent failure, so a streak the classifier had bucketed as
 *      transient could run indefinitely with the persistent counter at zero and
 *      the state frozen at `error_transient`.
 *   2. `IntegrationStatus` is keyed `(userId, integration)` while Withings runs
 *      four legs on four crons and WHOOP four resources on four more. An
 *      unconditional success cleared the error, the buckets, the streak anchor
 *      and the state that a DIFFERENT leg had recorded, several times an hour,
 *      so the failing leg's strike ladder could never climb.
 *
 * The dispatcher is mocked at module level so the alert path resolves without
 * dialling Telegram; the assertions are on ledger state, not the network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/logging/signal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/signal")>();
  return { ...actual, emitSignal: vi.fn(actual.emitSignal) };
});

vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
}));

import {
  getIntegrationStatus,
  isReauthRequired,
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";
import { emitSignal } from "@/lib/logging/signal";

const TEST_USER_ID = "user-sync-escalation";
const HOUR_MS = 60 * 60 * 1000;

function row(integration: string) {
  return getPrismaClient().integrationStatus.findUnique({
    where: { userId_integration: { userId: TEST_USER_ID, integration } },
  });
}

/**
 * Age the streak anchor backwards so a multi-day window can be exercised
 * without a multi-day test. Only the anchor moves — every counter, the state
 * and the error stay exactly as the production writes left them.
 */
async function ageStreakBy(integration: string, ms: number) {
  const current = await row(integration);
  const anchor = current!.failingSinceAt!;
  await getPrismaClient().integrationStatus.update({
    where: { userId_integration: { userId: TEST_USER_ID, integration } },
    data: { failingSinceAt: new Date(anchor.getTime() - ms) },
  });
}

async function agePersistentAnchorBy(integration: string, ms: number) {
  const current = await row(integration);
  const anchor = current!.persistentFailureStartedAt!;
  await getPrismaClient().integrationStatus.update({
    where: { userId_integration: { userId: TEST_USER_ID, integration } },
    data: { persistentFailureStartedAt: new Date(anchor.getTime() - ms) },
  });
}

async function failTransient(integration: string, leg?: string) {
  await recordSyncFailure({
    userId: TEST_USER_ID,
    integration: integration as "withings",
    kind: "transient",
    message: `${integration} sync error: 503 - upstream unavailable`,
    errorCode: "503",
    leg,
  });
}

beforeEach(async () => {
  vi.mocked(emitSignal).mockClear();
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "sync-escalation",
      email: "sync-escalation@example.test",
    },
  });
});

describe("failure escalation", () => {
  it("escalates an unbroken transient streak to persistent once it outlives the transient window", async () => {
    // Three hourly failures — a real burst, still inside the window.
    await failTransient("withings");
    await failTransient("withings");
    await failTransient("withings");

    let current = await row("withings");
    expect(current!.state).toBe("error_transient");
    expect(current!.consecutiveFailuresByKind).toMatchObject({
      transient: 3,
      persistent: 0,
    });
    expect(current!.persistentFailureStartedAt).toBeNull();
    expect(current!.failingSinceAt).toBeInstanceOf(Date);

    // The upstream stays broken for a full day. Nothing else changes.
    await ageStreakBy("withings", 25 * HOUR_MS);
    await failTransient("withings");

    current = await row("withings");
    // The transient bucket is frozen where the window closed; the failure now
    // counts against the persistent bucket the park ladder reads.
    expect(current!.consecutiveFailuresByKind).toMatchObject({
      transient: 3,
      persistent: 1,
    });
    expect(current!.persistentFailureStartedAt).toBeInstanceOf(Date);

    const signals = vi
      .mocked(emitSignal)
      .mock.calls.map(([signal]) => signal)
      .filter((signal) => signal.action === "integrations.sync.failed");
    const last = signals[signals.length - 1]!.meta!;
    expect(last.kind).toBe("persistent");
    // The signal keeps the classifier's own verdict, so an operator can tell
    // "the upstream said this was permanent" from "we concluded it was".
    expect(last.escalated_from).toBe("transient");
  });

  it("parks the escalated streak a further window later and stops attempting", async () => {
    await failTransient("withings");
    await failTransient("withings");
    await failTransient("withings");
    await ageStreakBy("withings", 25 * HOUR_MS);
    await failTransient("withings");

    // Escalated, still retrying — parking on the same tick would turn one long
    // upstream outage into a manual reconnect for every account.
    expect((await row("withings"))!.state).toBe("error_transient");
    expect(await isReauthRequired(TEST_USER_ID, "withings")).toBe(false);

    // A second day of the same.
    await agePersistentAnchorBy("withings", 25 * HOUR_MS);
    await failTransient("withings");

    const current = await row("withings");
    expect(current!.state).toBe("parked");
    expect(await isReauthRequired(TEST_USER_ID, "withings")).toBe(true);

    const parked = await getPrismaClient().auditLog.findMany({
      where: { action: "integrations.parked", userId: TEST_USER_ID },
    });
    expect(parked).toHaveLength(1);
  });

  it("does not escalate a short outage that recovers", async () => {
    // Well past the wall-clock window, but the streak keeps being broken by a
    // success — which is exactly what a flapping upstream looks like.
    for (let cycle = 0; cycle < 4; cycle++) {
      await failTransient("withings");
      await failTransient("withings");
      await ageStreakBy("withings", 48 * HOUR_MS);
      await recordSyncSuccess(TEST_USER_ID, "withings");
    }

    const current = await row("withings");
    expect(current!.state).toBe("connected");
    expect(current!.consecutiveFailuresByKind).toMatchObject({
      transient: 0,
      reauth_required: 0,
      persistent: 0,
    });
    expect(current!.persistentFailureStartedAt).toBeNull();
    expect(current!.failingSinceAt).toBeNull();
    expect(current!.lastError).toBeNull();
  });

  it("does not escalate on wall-clock alone below the consecutive-failure threshold", async () => {
    // A rarely-polled provider: one failure, then a day passes, then a second.
    // Time is necessary but not sufficient — otherwise a provider that ticks
    // once a day would escalate on its second-ever attempt.
    await failTransient("nightscout");
    await ageStreakBy("nightscout", 25 * HOUR_MS);
    await failTransient("nightscout");

    const current = await row("nightscout");
    expect(current!.state).toBe("error_transient");
    expect(current!.consecutiveFailuresByKind).toMatchObject({
      transient: 2,
      persistent: 0,
    });
    expect(current!.persistentFailureStartedAt).toBeNull();
  });

  it("parks a rejected credential at error_reauth on the first failure instead of retrying it", async () => {
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "whoop",
      kind: "reauth_required",
      message: "WHOOP refresh error: 400 - invalid_grant",
      errorCode: "invalid_grant",
      leg: "recovery",
    });

    const current = await row("whoop");
    expect(current!.state).toBe("error_reauth");
    expect(current!.failingSinceAt).toBeInstanceOf(Date);
    // The sync entry-points short-circuit — a revoked grant is not retried a
    // thousand times.
    expect(await isReauthRequired(TEST_USER_ID, "whoop")).toBe(true);
  });

  it("dates the streak from its first failure, not from the last retry", async () => {
    await failTransient("withings");
    const firstAttempt = (await row("withings"))!.failingSinceAt!;

    await failTransient("withings");
    await failTransient("withings");

    const current = await row("withings");
    expect(current!.failingSinceAt!.getTime()).toBe(firstAttempt.getTime());
    // `lastAttemptAt` keeps moving — that is the field that made a fortnight of
    // silence read as "failing, just now".
    expect(current!.lastAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      firstAttempt.getTime(),
    );

    const snapshot = await getIntegrationStatus(TEST_USER_ID, "withings");
    expect(snapshot.failingSince).toBe(firstAttempt.toISOString());
  });
});

describe("leg-scoped success", () => {
  it("does not let a sibling leg's success clear another leg's error", async () => {
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "withings",
      kind: "transient",
      message: "sleep write failed: reconciliation conflict",
      leg: "sleep",
    });
    const afterFailure = await row("withings");
    const streakStart = afterFailure!.failingSinceAt!;

    // The ECG leg ticks 26 minutes later and is perfectly healthy.
    await recordSyncSuccess(TEST_USER_ID, "withings", { leg: "ecg" });

    const current = await row("withings");
    expect(current!.state).toBe("error_transient");
    expect(current!.lastError).toBe(afterFailure!.lastError);
    expect(current!.consecutiveFailuresByKind).toMatchObject({ transient: 1 });
    expect(current!.failingLegs).toEqual(["sleep"]);
    expect(current!.failingSinceAt!.getTime()).toBe(streakStart.getTime());
    // Not advanced: it is what the card's "connected · X ago" reads, and the
    // sleep pipe has delivered nothing.
    expect(current!.lastSuccessAt).toBeNull();
    // The attempt did happen, so the row must not age into `stalled`.
    expect(current!.lastAttemptAt).toBeInstanceOf(Date);
  });

  it("lets the owning leg's own success clear the row whole", async () => {
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "withings",
      kind: "transient",
      message: "sleep write failed: reconciliation conflict",
      leg: "sleep",
    });
    await recordSyncSuccess(TEST_USER_ID, "withings", { leg: "ecg" });
    await recordSyncSuccess(TEST_USER_ID, "withings", { leg: "sleep" });

    const current = await row("withings");
    expect(current!.state).toBe("connected");
    expect(current!.lastError).toBeNull();
    expect(current!.failingLegs).toEqual([]);
    expect(current!.failingSinceAt).toBeNull();
    expect(current!.lastSuccessAt).toBeInstanceOf(Date);
    expect(current!.consecutiveFailuresByKind).toMatchObject({
      transient: 0,
      reauth_required: 0,
      persistent: 0,
    });
  });

  it("keeps a leg's reauth park standing against a sibling leg's success", async () => {
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "withings",
      kind: "reauth_required",
      message: "Withings sleep error: 403",
      errorCode: "403",
      leg: "sleep",
    });
    expect(await isReauthRequired(TEST_USER_ID, "withings")).toBe(true);

    await recordSyncSuccess(TEST_USER_ID, "withings", { leg: "ecg" });

    // Un-parking here is the worst shape of the bug: the sleep leg's grant is
    // gone, and the row went back to claiming a healthy connection.
    expect(await isReauthRequired(TEST_USER_ID, "withings")).toBe(true);
    expect((await row("withings"))!.state).toBe("error_reauth");
  });

  it("lets a sibling success be counted while the strike ladder still climbs", async () => {
    // The regression, end to end: the failing leg fails hourly, a healthy leg
    // succeeds in between, and the streak must still reach the escalation.
    for (let hour = 0; hour < 3; hour++) {
      await failTransient("withings", "sleep");
      await recordSyncSuccess(TEST_USER_ID, "withings", { leg: "ecg" });
    }
    await ageStreakBy("withings", 25 * HOUR_MS);
    await failTransient("withings", "sleep");

    const current = await row("withings");
    expect(current!.consecutiveFailuresByKind).toMatchObject({
      transient: 3,
      persistent: 1,
    });
    expect(current!.persistentFailureStartedAt).toBeInstanceOf(Date);
  });

  it("clears the row whole when a full pass names no leg", async () => {
    // A run that covered every resource is entitled to clear everything, and a
    // single-leg provider that never names a leg keeps its old behaviour.
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "whoop",
      kind: "transient",
      message: "WHOOP workout error: 503",
      leg: "workout",
    });
    await recordSyncSuccess(TEST_USER_ID, "whoop");

    const current = await row("whoop");
    expect(current!.state).toBe("connected");
    expect(current!.lastError).toBeNull();
    expect(current!.failingLegs).toEqual([]);
    expect(current!.failingSinceAt).toBeNull();
  });

  it("lets any success clear an unattributed failure", async () => {
    await failTransient("oura");
    await recordSyncSuccess(TEST_USER_ID, "oura", { leg: "vitals" });

    const current = await row("oura");
    expect(current!.state).toBe("connected");
    expect(current!.lastError).toBeNull();
    expect(current!.failingSinceAt).toBeNull();
  });
});

describe("two legs failing in overlapping windows", () => {
  /**
   * The case a single `failing_leg` slot could not hold, and the one the
   * v1.33.0 notes named in public rather than fixed.
   *
   * Sleep fails, then activity fails. With one slot, activity's failure
   * overwrote sleep's, so activity recovering cleared the row whole — the
   * error, the buckets and the streak anchor — while sleep was still dead. The
   * card went green over a data class that had stopped arriving weeks earlier,
   * and the strike ladder restarted from zero every time the healthy leg ticked.
   */
  it("remembers the earlier leg after the later one recovers", async () => {
    await failTransient("withings", "sleep");
    const afterSleep = await row("withings");
    const streakStart = afterSleep!.failingSinceAt!;

    await failTransient("withings", "activity");
    // Both legs are on the row. The slot could only ever have held one.
    expect((await row("withings"))!.failingLegs).toEqual(["sleep", "activity"]);

    // Activity comes back. Sleep has not.
    await recordSyncSuccess(TEST_USER_ID, "withings", { leg: "activity" });

    const current = await row("withings");
    expect(current!.failingLegs).toEqual(["sleep"]);
    // The error still stands, dated from sleep's first failure, with both
    // strikes intact — this is the ladder that could never climb.
    expect(current!.state).toBe("error_transient");
    expect(current!.failingSinceAt!.getTime()).toBe(streakStart.getTime());
    expect(current!.consecutiveFailuresByKind).toMatchObject({ transient: 2 });
    // Still nothing has been delivered by the sleep leg, so the field the card
    // reads as "connected · X ago" must not have moved.
    expect(current!.lastSuccessAt).toBeNull();
  });

  it("drops the error message once the leg that wrote it recovers", async () => {
    await failTransient("withings", "sleep");
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "withings",
      kind: "transient",
      message: "activity write failed: upstream 503",
      leg: "activity",
    });
    // Activity failed last, so its message is the one the row holds.
    expect((await row("withings"))!.lastError).not.toBeNull();

    await recordSyncSuccess(TEST_USER_ID, "withings", { leg: "activity" });

    const current = await row("withings");
    // Keeping activity's message would leave the row describing a leg that has
    // recovered while sleep is the one still failing. No message is honest
    // here; a guessed one would not be.
    expect(current!.lastError).toBeNull();
    expect(current!.failingLegs).toEqual(["sleep"]);
    expect(current!.state).toBe("error_transient");
  });

  it("keeps the message when a leg that did not write it recovers", async () => {
    await recordSyncFailure({
      userId: TEST_USER_ID,
      integration: "withings",
      kind: "transient",
      message: "activity write failed: upstream 503",
      leg: "activity",
    });
    await failTransient("withings", "sleep");
    const sleepMessage = (await row("withings"))!.lastError;

    // Activity recovers, but sleep failed last and owns the message.
    await recordSyncSuccess(TEST_USER_ID, "withings", { leg: "activity" });

    const current = await row("withings");
    expect(current!.lastError).toBe(sleepMessage);
    expect(current!.failingLegs).toEqual(["sleep"]);
  });

  it("clears the row only once every failing leg has come back", async () => {
    await failTransient("withings", "sleep");
    await failTransient("withings", "activity");
    await failTransient("withings", "ecg");

    await recordSyncSuccess(TEST_USER_ID, "withings", { leg: "ecg" });
    await recordSyncSuccess(TEST_USER_ID, "withings", { leg: "sleep" });
    expect((await row("withings"))!.state).toBe("error_transient");
    expect((await row("withings"))!.failingLegs).toEqual(["activity"]);

    await recordSyncSuccess(TEST_USER_ID, "withings", { leg: "activity" });

    const current = await row("withings");
    expect(current!.state).toBe("connected");
    expect(current!.failingLegs).toEqual([]);
    expect(current!.failingSinceAt).toBeNull();
    expect(current!.lastError).toBeNull();
    expect(current!.lastSuccessAt).toBeInstanceOf(Date);
    expect(current!.consecutiveFailuresByKind).toMatchObject({
      transient: 0,
      reauth_required: 0,
      persistent: 0,
    });
  });

  it("does not duplicate a leg that keeps failing", async () => {
    await failTransient("withings", "sleep");
    await failTransient("withings", "activity");
    await failTransient("withings", "sleep");

    // Sleep moves to the end because it wrote the message the row now holds.
    expect((await row("withings"))!.failingLegs).toEqual(["activity", "sleep"]);
  });

  it("does not let an unattributed failure erase a named leg", async () => {
    await failTransient("withings", "sleep");
    // A recorder that caught the error at a boundary and cannot say which leg
    // it belongs to. Overwriting the set here would let the sleep leg's next
    // success clear an error it did not fix.
    await failTransient("withings");

    expect((await row("withings"))!.failingLegs).toEqual(["sleep"]);
  });
});
