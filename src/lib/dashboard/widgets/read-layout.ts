/**
 * The stored dashboard layout of one account, resolved for `GET
 * /api/dashboard/widgets`: defaults merged in when the account has not
 * customised it, with the optimistic-concurrency token beside it.
 */
import { prisma } from "@/lib/db";
import {
  resolveDashboardLayout,
  type DashboardLayoutWithToken,
} from "@/lib/dashboard-layout";

export async function buildDashboardLayout(
  userId: string,
): Promise<DashboardLayoutWithToken> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    // Issue #581: `updatedAt` rides the cached layout so GET hands the
    // client the optimistic-concurrency token alongside the layout it
    // applies to. Cached together (and busted on every write) so the
    // (layout, token) pair a client reads is always consistent.
    select: { dashboardWidgetsJson: true, updatedAt: true },
  });
  const layout = resolveDashboardLayout(row?.dashboardWidgetsJson);
  return { ...layout, updatedAt: row?.updatedAt?.toISOString() };
}
