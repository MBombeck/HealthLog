import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  getIntegrationStatus,
  type IntegrationKey,
} from "@/lib/integrations/status";
import {
  INTEGRATION_CADENCE,
  resolveSyncVerdict,
} from "@/lib/integrations/sync-verdict";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/** Output schema for `get_integration_status` — per-provider sync health. */
const getIntegrationStatusOutput: z.ZodRawShape = {
  present: z.boolean(),
  providers: z
    .array(
      z.object({
        provider: z.string(),
        state: z.string(),
        connected: z.boolean(),
        reauthRequired: z.boolean(),
        lastSuccessAt: z.string().nullable(),
        lastAttemptAt: z.string().nullable(),
        verdict: z.string(),
        since: z.string().nullable(),
      }),
    )
    .optional(),
};

export const getIntegrationStatusTool: McpToolDefinition = {
  name: "get_integration_status",
  title: "Get device & service sync status",
  description:
    "Fetch the sync health of the user's connected devices and services (Withings, WHOOP, Fitbit, Nightscout, Polar, Oura, Strava, Google Health) — which are connected, when each last synced, and whether one needs reconnecting or is failing. Answers 'why is my data stale?'. Reuses the integration-status ledger; carries no secrets or tokens. `connected` means only 'not explicitly disconnected'; `verdict` is the liveness truth (fresh / stale / stalled / failing / reauth_required / parked / pending_first_sync / disconnected), where `stalled` means the sync has stopped even attempting. Returns { present: false } when no integration has ever attempted a sync.",
  inputShape: {},
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getIntegrationStatusOutput,
  async run(ctx) {
    // Only providers with a status row have actually attempted a sync — a
    // synthetic "never attempted" provider must NOT be reported as connected.
    const rows = await prisma.integrationStatus.findMany({
      where: { userId: ctx.userId },
      select: { integration: true },
    });
    if (rows.length === 0) {
      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_integration_status", present: false },
      });
      return { present: false };
    }

    const providers = await Promise.all(
      rows.map(async (r) => {
        const s = await getIntegrationStatus(
          ctx.userId,
          r.integration as IntegrationKey,
        );
        // `connected` means "not explicitly disconnected" and says nothing
        // about liveness — a month-dead pull still reads true. `verdict` is
        // the liveness truth, resolved by the same server-side rule the
        // Settings page renders.
        const health = resolveSyncVerdict({
          configured: true,
          state: s.state,
          lastSuccessAt: s.lastSuccessAt,
          lastAttemptAt: s.lastAttemptAt,
          failingSinceAt: s.failingSince,
          cadence: INTEGRATION_CADENCE[s.integration],
        });
        return {
          provider: s.integration,
          state: s.state,
          connected: s.state !== "disconnected",
          reauthRequired: s.state === "error_reauth" || s.state === "parked",
          lastSuccessAt: s.lastSuccessAt,
          lastAttemptAt: s.lastAttemptAt,
          verdict: health.verdict,
          since: health.since,
        };
      }),
    );

    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_integration_status", present: true },
    });
    return { present: true, providers };
  },
};
