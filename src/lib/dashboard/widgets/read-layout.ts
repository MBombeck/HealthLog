/**
 * The stored dashboard layout of one account, resolved for `GET
 * /api/dashboard/widgets`: defaults merged in when the account has not
 * customised it, with the optimistic-concurrency token beside it.
 */
import { prisma } from "@/lib/db";
import { userDocumentToken } from "@/lib/optimistic-lock";
import {
  resolveDashboardLayout,
  type DashboardLayoutWithToken,
} from "@/lib/dashboard-layout";

export async function buildDashboardLayout(
  userId: string,
): Promise<DashboardLayoutWithToken> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    // Issue #581: the lock token rides with the layout it applies to. It is
    // the layout's own revision, never the row's `updatedAt`, which every
    // other write to the account row moves.
    select: { dashboardWidgetsJson: true, dashboardWidgetsRevisedAt: true },
  });
  const layout = resolveDashboardLayout(row?.dashboardWidgetsJson);
  return { ...layout, updatedAt: userDocumentToken(row, "dashboardWidgets") };
}
