/**
 * The new lab panel a reaction line is written about, as evidence lines for
 * the model (`loadArrivalEvidence` in `./reaction-line`).
 *
 * Module-gated: an arrival is only emitted with Labs on, but its job can run
 * after the owner switched the module off, and then the model gets no value.
 */
import { fenceUserText } from "@/lib/ai/coach/data-fence";
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/gate";

/** Up to eight results of the panel, fenced; null when there is nothing to say. */
export async function labsPanelEvidence(
  userId: string,
  arrival: { occurredAt: Date; refId: string | null },
): Promise<string | null> {
  if (!(await isModuleEnabled(userId, "labs"))) return null;
  const labs = await prisma.labResult.findMany({
    where: {
      userId,
      takenAt: arrival.occurredAt,
      deletedAt: null,
      ...(arrival.refId ? { panel: arrival.refId } : {}),
    },
    select: { analyte: true, value: true, valueText: true, unit: true },
    orderBy: { analyte: "asc" },
    take: 8,
  });
  if (labs.length === 0) return null;
  return labs
    .map((lab) => {
      const value =
        lab.value === null
          ? fenceUserText(lab.valueText ?? "not reported")
          : String(lab.value);
      const unit = lab.unit ? ` ${fenceUserText(lab.unit)}` : "";
      return `- Newly arrived lab result: ${fenceUserText(lab.analyte)} ${value}${unit}.`;
    })
    .join("\n");
}
