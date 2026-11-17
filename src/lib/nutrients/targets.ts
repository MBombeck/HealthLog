/**
 * The read side of the person's daily nutrient targets (#1402), shared by the
 * targets route, the daily series and the MCP `get_nutrients` tool.
 */
import { prisma } from "@/lib/db";
import {
  parseNutrientTargets,
  type NutrientTargets,
} from "@/lib/validations/nutrient-targets";

export async function readNutrientTargets(
  userId: string,
): Promise<NutrientTargets> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { nutrientTargetsJson: true },
  });
  return parseNutrientTargets(row?.nutrientTargetsJson ?? null);
}
