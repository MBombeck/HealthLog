/**
 * v1.39 — the setup flow's state, for the server-rendered pages.
 *
 * One read per request: the page that guards a URL and the metadata that
 * titles it both ask for the same row, and `cache` makes the second ask free.
 * The DTO is the same one `GET /api/auth/me` publishes (`toOnboardingStateDto`
 * with the account's own unit columns), so the screen the server paints and
 * the screen the client reasons about after hydration are built from one
 * shape.
 *
 * The caller's OWN record, always. The flow's three writes refuse under an
 * acting-account switch, so a page that read the switched record's state would
 * show questions nobody could answer.
 */
import { cache } from "react";

import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { readHeldUnitPreferences, type OnboardingStateDto } from "./needs";
import { serverSetupOpenFor } from "@/lib/admin/server-setup-store";
import { loadOnboardingOffers } from "./load-offers";
import { loadOnboardingRecordRow, toOnboardingStateDto } from "./needs-store";
import { parsePinnedPlan, type PersonSegmentId } from "./wizard-steps";

export interface OnboardingFlowPageState {
  userId: string;
  userLocale: string | null;
  state: OnboardingStateDto;
  /** 1.50 — the segments pinned when the flow started, or null. */
  plan: PersonSegmentId[] | null;
  /** 1.49 — an admin whose server setup is still open (never on a demo). */
  serverSetupOpen: boolean;
  /**
   * The account's own completion stamp (`User.onboardingCompletedAt`), the
   * one the first-run redirect follows. Distinct from the record's
   * `state.completedAt`.
   */
  accountCompleted: boolean;
}

export const loadOnboardingFlowState = cache(
  async (): Promise<OnboardingFlowPageState | null> => {
    const session = await getSession();
    if (!session) return null;
    const { user } = session;
    const [row, offers, serverSetupOpen, pinned] = await Promise.all([
      loadOnboardingRecordRow(prisma, user.id),
      loadOnboardingOffers(user.id),
      serverSetupOpenFor(user),
      prisma.onboardingRecord.findUnique({
        where: { userId: user.id },
        select: { planJson: true },
      }),
    ]);
    return {
      userId: user.id,
      userLocale: user.locale ?? null,
      state: toOnboardingStateDto(row, readHeldUnitPreferences(user), offers),
      // A demo deploy's one account is shared by every visitor: its flow is
      // the "you" part only, nothing that connects or reminds.
      plan:
        process.env.DEMO_MODE === "true"
          ? ["you"]
          : parsePinnedPlan(pinned?.planJson ?? null),
      serverSetupOpen,
      accountCompleted: user.onboardingCompletedAt != null,
    };
  },
);
