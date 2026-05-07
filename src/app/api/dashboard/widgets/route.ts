/**
 * GET / PUT / DELETE dashboard widget layout.
 *
 * GET returns the resolved effective layout (defaults merged in if the user
 * hasn't customized yet). PUT replaces the layout atomically. DELETE resets
 * to default.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import {
  resolveDashboardLayout,
  serializeDashboardLayout,
  DEFAULT_DASHBOARD_LAYOUT,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import { Prisma } from "@/generated/prisma/client";
import { z } from "zod/v4";
import type { NextRequest } from "next/server";

const widgetIdEnum = z.enum([
  "weight",
  "bp",
  "pulse",
  "bodyFat",
  "mood",
  "medications",
  "sleep",
  "steps",
  "glucose",
  "totalBodyWater",
  "boneMass",
  "bpInTarget",
  "oxygenSaturation",
]);

const layoutSchema = z.object({
  version: z.literal(1),
  widgets: z
    .array(
      z.object({
        id: widgetIdEnum,
        visible: z.boolean(),
        order: z.number().int().min(0).max(99),
      }),
    )
    .min(1)
    .max(20),
});

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { dashboardWidgetsJson: true },
  });

  const layout = resolveDashboardLayout(row?.dashboardWidgetsJson);
  return apiSuccess(layout);
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = layoutSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const normalized = serializeDashboardLayout(parsed.data as DashboardLayout);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      dashboardWidgetsJson: normalized as unknown as Prisma.InputJsonValue,
    },
  });

  annotate({
    action: { name: "dashboard.widgets.update" },
    meta: { visible_count: normalized.widgets.filter((w) => w.visible).length },
  });

  return apiSuccess(normalized);
});

export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();

  await prisma.user.update({
    where: { id: user.id },
    data: { dashboardWidgetsJson: Prisma.JsonNull },
  });

  annotate({ action: { name: "dashboard.widgets.reset" } });

  return apiSuccess(DEFAULT_DASHBOARD_LAYOUT);
});
