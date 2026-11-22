/**
 * The server facts the setup flow's follow-ups depend on, for one's own
 * record (1.49).
 *
 * Every route that publishes the setup state builds it through
 * `toOnboardingStateDto`, which requires these, so a route cannot publish a
 * state whose follow-ups were decided without them. The account payload reads
 * them off the AI block it already resolved (`onboardingOffersFromAi`); the
 * setup routes, which write the caller's own record only, load them here.
 */
import { loadAiCapabilities } from "@/lib/ai/capabilities/load";

import {
  NO_ONBOARDING_OFFERS,
  onboardingOffersFromAi,
  type OnboardingOffers,
} from "./needs";

export async function loadOnboardingOffers(
  userId: string,
): Promise<OnboardingOffers> {
  try {
    const ai = await loadAiCapabilities({
      recordId: userId,
      authority: {
        origin: "owner",
        recordUserId: userId,
        actorUserId: userId,
        grantId: null,
      },
      sections: null,
      recordKind: "self",
    });
    return onboardingOffersFromAi(ai);
  } catch {
    // Fail closed: without the facts the AI follow-up is not offered, which
    // costs a screen and never sends anything anywhere.
    return NO_ONBOARDING_OFFERS;
  }
}
