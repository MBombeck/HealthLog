/**
 * Reset the web-controlled dashboard choices of one account to their
 * defaults, preserving its other layout preferences.
 */
import { prisma, toJson } from "@/lib/db";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  resolveDashboardLayout,
  serializeDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

export async function resetDashboardLayout(
  userId: string,
): Promise<{ normalized: DashboardLayout; updatedAt: string }> {
  // Under a row lock rather than Serializable isolation: a reset racing a
  // chart-overlay toggle on the same account waits for it instead of
  // failing with a serialization error (a 500).
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const existing = await tx.user.findUnique({
      where: { id: userId },
      select: { dashboardWidgetsJson: true },
    });
    const existingLayout = resolveDashboardLayout(
      existing?.dashboardWidgetsJson,
    );
    const normalized = serializeDashboardLayout({
      ...existingLayout,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets,
      enabledHeroItemKinds: DEFAULT_DASHBOARD_LAYOUT.enabledHeroItemKinds,
      // A reset brings a hidden top card back.
      todayCardVisible: DEFAULT_DASHBOARD_LAYOUT.todayCardVisible,
    });

    const updated = await tx.user.update({
      where: { id: userId },
      data: { dashboardWidgetsJson: toJson(normalized) },
      select: { updatedAt: true },
    });
    return { normalized, updatedAt: updated.updatedAt.toISOString() };
  });
}
