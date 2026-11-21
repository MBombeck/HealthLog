/**
 * `GET /api/emergency-card` — the caller's own emergency card (v1.49): every
 * item, read the way the card's link reads its ticked ones
 * (`loadEmergencyCard`). The owner's card page renders it, builds the offline
 * copy and the wallet PDF from it, and the iOS app can read it for a
 * lock-screen surface.
 *
 * Always the caller's own record (`requireActorAuth`): a delegate or a
 * guardian reading inside someone else's record gets their own card, never
 * the owner's. A narrow Bearer token is refused by the default scope arm.
 */
import { apiHandler, requireActorAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import {
  emergencyCardHasContent,
  loadEmergencyCard,
} from "@/lib/emergency-card/card-data";
import { annotate } from "@/lib/logging/context";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireActorAuth();
  const today = moodDateKey(new Date(), user.timezone ?? DEFAULT_TIMEZONE);
  const card = await loadEmergencyCard(user.id, today);
  annotate({
    action: { name: "emergency-card.read" },
    meta: { has_content: emergencyCardHasContent(card) },
  });
  return apiSuccess({ card });
});
