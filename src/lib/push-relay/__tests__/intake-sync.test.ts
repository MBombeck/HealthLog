import { describe, expect, it } from "vitest";

import {
  judgeIntakeSync,
  type IntakeSyncEvidence,
} from "@/lib/push-relay/capability";
import { templateFor } from "@/lib/push-relay/envelope";

const now = new Date("2026-11-23T12:00:00.000Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

function evidence(extra: Partial<IntakeSyncEvidence> = {}): IntakeSyncEvidence {
  return {
    relayOk: true,
    envelopeReportedAt: now,
    lastRecorded: null,
    lastAcceptedAlert: null,
    lastConfirmedAlertAt: null,
    ...extra,
  };
}

describe("the receipt rule's premise", () => {
  it("every relay alert wakes the notification service extension", () => {
    // Only alerts are judged by their receipts, because the extension opens
    // each one on arrival. Without `mutable-content` it would not run, and
    // every alert would read as lost.
    expect(templateFor("alert", "e").aps).toMatchObject({
      "mutable-content": 1,
    });
  });
});

describe("judgeIntakeSync", () => {
  it("reads ok without evidence", () => {
    expect(judgeIntakeSync(evidence())).toEqual({ state: "ok", reason: null });
  });

  it("degrades while the relay is not healthy", () => {
    expect(judgeIntakeSync(evidence({ relayOk: false }))).toEqual({
      state: "degraded",
      reason: "relay",
    });
  });

  it("degrades on a newest alert never opened although the device reported well after", () => {
    expect(
      judgeIntakeSync(
        evidence({
          lastAcceptedAlert: { acceptedAt: ago(60), confirmedAt: null },
        }),
      ),
    ).toEqual({ state: "degraded", reason: "alert_unconfirmed" });
  });

  it("gives the device ten minutes, and needs a report to judge at all", () => {
    const fresh = { acceptedAt: ago(5), confirmedAt: null };
    expect(judgeIntakeSync(evidence({ lastAcceptedAlert: fresh })).state).toBe(
      "ok",
    );
    expect(
      judgeIntakeSync(
        evidence({
          envelopeReportedAt: null,
          lastAcceptedAlert: { acceptedAt: ago(60), confirmedAt: null },
        }),
      ).state,
    ).toBe("ok");
  });

  it("reads ok once the newest alert is opened", () => {
    expect(
      judgeIntakeSync(
        evidence({
          lastAcceptedAlert: { acceptedAt: ago(60), confirmedAt: ago(50) },
          lastConfirmedAlertAt: ago(60),
        }),
      ),
    ).toEqual({ state: "ok", reason: null });
  });

  it("degrades on a dropped or failed dose confirmation with no alert opened after it", () => {
    for (const status of ["dropped", "failed"]) {
      expect(
        judgeIntakeSync(
          evidence({
            lastRecorded: { status, createdAt: ago(60) },
            lastConfirmedAlertAt: ago(90),
          }),
        ),
      ).toEqual({ state: "degraded", reason: "intake_recorded_dropped" });
    }
  });

  it("clears a dropped dose confirmation once a later alert is opened", () => {
    expect(
      judgeIntakeSync(
        evidence({
          lastRecorded: { status: "dropped", createdAt: ago(60) },
          lastAcceptedAlert: { acceptedAt: ago(30), confirmedAt: ago(29) },
          lastConfirmedAlertAt: ago(30),
        }),
      ),
    ).toEqual({ state: "ok", reason: null });
  });

  it("reads ok for an accepted dose confirmation", () => {
    expect(
      judgeIntakeSync(
        evidence({ lastRecorded: { status: "accepted", createdAt: ago(60) } }),
      ).state,
    ).toBe("ok");
  });
});
