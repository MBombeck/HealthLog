/**
 * `GET /api/cycle/profile` — full CycleProfileDTO (ios-contract §2.G).
 *
 * Gated like every cycle route; returns the lazily-upserted profile with
 * the resolved `cycleTrackingEnabled`.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { isCycleEnabled } from "@/lib/cycle/enabled";
import { toCycleProfileDTO } from "@/lib/cycle/dto";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "cycle");

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const resolved = isCycleEnabled(user.gender, gate.profile);

  annotate({ action: { name: "cycle.profile.read" } });

  return apiSuccess(toCycleProfileDTO(gate.profile, resolved));
});
