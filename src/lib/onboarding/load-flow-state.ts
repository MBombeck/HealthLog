/**
 * v1.39 (C2) — the setup flow's state, for the server-rendered pages.
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
import { loadOnboardingRecordRow, toOnboardingStateDto } from "./needs-store";

export interface OnboardingFlowPageState {
  userId: string;
  userLocale: string | null;
  state: OnboardingStateDto;
}

export const loadOnboardingFlowState = cache(
  async (): Promise<OnboardingFlowPageState | null> => {
    const session = await getSession();
    if (!session) return null;
    const { user } = session;
    const row = await loadOnboardingRecordRow(prisma, user.id);
    return {
      userId: user.id,
      userLocale: user.locale ?? null,
      state: toOnboardingStateDto(row, readHeldUnitPreferences(user)),
    };
  },
);
