import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import {
  readEmergencyProfile,
  writeEmergencyProfile,
} from "@/lib/profile/emergency-profile";
import { emergencyProfileUpdateSchema } from "@/lib/validations/emergency-profile";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const payload = await readEmergencyProfile(user.id);
  annotate({
    action: { name: "anamnesis.emergency.get" },
    meta: {
      has_blood_type: payload.bloodType !== null,
      has_contacts: payload.contacts !== null,
      has_implants: payload.implants !== null,
    },
  });
  return apiSuccess(payload);
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const parsed = await parseJsonBody(request, emergencyProfileUpdateSchema, {
    maxBytes: 16 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  const payload = await writeEmergencyProfile(user.id, parsed.data);
  await auditLog("anamnesis.emergency.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { fields: Object.keys(parsed.data).sort() },
  });
  annotate({
    action: {
      name: "anamnesis.emergency.update",
      entity_type: "user_health_profile",
      entity_id: user.id,
    },
    meta: { fields: Object.keys(parsed.data).sort() },
  });
  return apiSuccess(payload);
});

export const dynamic = "force-dynamic";
