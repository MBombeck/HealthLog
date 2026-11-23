/**
 * `GET /api/emergency-card` — the caller's own emergency card (v1.49): every
 * item, read the way the card's link reads its ticked ones
 * (`loadEmergencyCard`). The owner's card page renders it, builds the offline
 * copy and the wallet PDF from it, and the iOS app can read it for a
 * lock-screen surface.
 *
 * Auth: through `requireGuardianAuth()`: the record's owner on their own
 * record, or the guardian of a managed profile (a MANAGE grant on a record
 * that carries the managed-profile marker), who holds the profile's card
 * because the profile has nobody who signs in. A delegate on an adult's
 * record is refused at every grant level: the card is the person's own.
 * A narrow Bearer token is refused by the default scope arm.
 */
import { apiHandler, requireGuardianAuth } from "@/lib/api-handler";
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
  const { user } = await requireGuardianAuth();
  const today = moodDateKey(new Date(), user.timezone ?? DEFAULT_TIMEZONE);
  const card = await loadEmergencyCard(user.id, today);
  annotate({
    action: { name: "emergency-card.read" },
    meta: { has_content: emergencyCardHasContent(card) },
  });
  return apiSuccess({ card });
});
