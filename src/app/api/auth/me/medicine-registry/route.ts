/**
 * The person's medicine registry (#1430).
 *
 *  PATCH /api/auth/me/medicine-registry — body
 *        `{ medicineRegistry: "PL" | "DE" | … | "EU" | "NONE" }`.
 *
 * Which country's (or the EU's) official medicine registry the "Find leaflet"
 * link on a medication opens. Independent of the interface language: a person
 * reading the app in English in Warsaw picks Poland. `NONE` hides the search.
 * The current value is published on `/api/auth/me` as `medicineRegistry`.
 *
 * Nothing is fetched from any registry, here or anywhere else: the medication
 * read builds a link from a static table, and the person's browser opens it.
 *
 * The per-user-scalar pattern of `glucose-unit` next door: 60/min rate
 * limit, a 1 KB body cap, Zod safeParse with a 422 on anything outside the
 * list, an audit row, a field-by-field write, and the resolved next state as
 * the answer. Idempotent.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { medicineRegistryPatchSchema } from "@/lib/validations/user-prefs";
import { resolveMedicineRegistry } from "@/lib/medications/medicine-registry";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `medicine-registry:patch:${user.id}`,
    PATCH_RATE_LIMIT,
    PATCH_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const parsed = await parseJsonBody(req, medicineRegistryPatchSchema, {
    maxBytes: 1024,
    action: "auth.me.medicine-registry.patch.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  const next = parsed.data.medicineRegistry;
  const previous = resolveMedicineRegistry(user);

  await prisma.user.update({
    where: { id: user.id },
    data: { medicineRegistry: next },
  });

  await auditLog("user.medicine-registry.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { previous, next },
  });

  annotate({
    action: { name: "auth.me.medicine-registry.patch" },
    meta: { medicineRegistry: next },
  });

  return apiSuccess({ medicineRegistry: next });
});
