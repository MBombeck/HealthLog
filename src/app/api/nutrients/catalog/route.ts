/**
 * `GET /api/nutrients/catalog` — the nutrient catalogue as the forms use it.
 *
 * One entry per code: canonical unit, label in the account's language,
 * whether the nutrient batch accepts it (`syncable`), whether a supplement's
 * composition may name it (`ingredient`), the input units with their
 * factor to the canonical unit, and the tolerable upper intake level with its
 * scope and source (or null). Clients build the composition form from this
 * and never convert units themselves.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { nutrientLabel } from "@/lib/medications/ingredients/composition";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { NUTRIENT_DEFINITIONS } from "@/lib/nutrients/catalog";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "measurements");
  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const entries = NUTRIENT_DEFINITIONS.map((def) => ({
    code: def.code,
    unit: def.unit,
    labelKey: def.labelKey,
    label: nutrientLabel(def.code, user.locale ?? null),
    syncable: def.syncable,
    ingredient: def.ingredient,
    inputUnits: def.inputUnits.map((u) => ({
      unit: u.unit,
      factorToCanonical: u.factorToCanonical,
    })),
    upperLimit: def.upperLimit,
  }));

  annotate({
    action: { name: "nutrient.catalog.read" },
    meta: { entry_count: entries.length },
  });
  return apiSuccess({ entries });
});
