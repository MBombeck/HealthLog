import { beforeEach, describe, expect, it, vi } from "vitest";

const claim = vi.hoisted(() => ({ result: true }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/notifications/reminder-dedup", () => ({
  claimNotificationEvent: vi.fn(async () => claim.result),
}));
vi.mock("@/lib/auth/security-alert", () => ({
  sendSecurityAlert: vi.fn(async () => true),
}));

import { claimNotificationEvent } from "@/lib/notifications/reminder-dedup";
import { sendSecurityAlert } from "@/lib/auth/security-alert";
import {
  MFA_GRACE_NOTICE_EVENT_TYPE,
  __resetMfaGraceNoticeForTests,
  noticeMfaGrace,
} from "../mfa-grace-notice";

const DUE = new Date("2026-12-10T09:00:00Z");

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  claim.result = true;
  __resetMfaGraceNoticeForTests();
});

describe("noticeMfaGrace", () => {
  it("sends the due notice once per account and date", async () => {
    noticeMfaGrace("u1", { state: "grace", dueAt: DUE });
    noticeMfaGrace("u1", { state: "grace", dueAt: DUE });
    await settle();
    expect(claimNotificationEvent).toHaveBeenCalledTimes(1);
    expect(claimNotificationEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recordUserId: "u1",
        eventType: MFA_GRACE_NOTICE_EVENT_TYPE,
        dedupKey: `mfa-due:${DUE.toISOString()}`,
      }),
    );
    expect(sendSecurityAlert).toHaveBeenCalledWith("u1", "mfa_due", {}, DUE);

    // A new date (the policy switched off and on again) is a new notice.
    const later = new Date(DUE.getTime() + 86_400_000);
    noticeMfaGrace("u1", { state: "grace", dueAt: later });
    await settle();
    expect(sendSecurityAlert).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when another process already claimed it", async () => {
    claim.result = false;
    noticeMfaGrace("u1", { state: "grace", dueAt: DUE });
    await settle();
    expect(sendSecurityAlert).not.toHaveBeenCalled();
  });

  it.each([
    ["none", { state: "none" as const, dueAt: null }],
    ["required", { state: "required" as const, dueAt: DUE }],
  ])("sends nothing in state %s", async (_label, enrollment) => {
    noticeMfaGrace("u1", enrollment);
    await settle();
    expect(claimNotificationEvent).not.toHaveBeenCalled();
  });
});
