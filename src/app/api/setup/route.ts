/**
 * 1.50 — the resolved setup state.
 *
 *  GET   /api/setup   where the person flow stands, the rows of the setup
 *                     card, and for an admin on a browser session the
 *                     instance setup and the rows of Admin › Setup
 *  PATCH /api/setup   `{ cardDismissed }`: hide the dashboard setup card,
 *                     or show it again (Settings › Account › Setup)
 *
 * Cookie or a wildcard Bearer token (`requireAuth()`): the iPhone app reads
 * where its person stands from here, and never decides which steps or rows
 * exist. The instance half is `null` on a Bearer token, which is never an
 * admin client. A demo deploy's shared account writes nothing.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveSetupState } from "@/lib/setup/resolve";
import { setupPatchSchema } from "@/lib/validations/setup";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user, authMethod } = await requireAuth();
  annotate({ action: { name: "setup.state.read" } });
  return apiSuccess(
    await resolveSetupState(user.id, { browser: authMethod === "cookie" }),
  );
});

export const PATCH = apiHandler(async (request: Request) => {
  const { user, authMethod } = await requireAuth();
  annotate({ action: { name: "setup.card.update" } });

  if (process.env.DEMO_MODE === "true") {
    return apiError("Not available on the demo", 403, {
      errorCode: "setup.demo",
    });
  }

  const rl = await checkRateLimit(`setup-card:${user.id}`, 30, 10 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Too many setup writes, try again later", 429, {
      errorCode: "setup.rateLimited",
    });
  }

  const parsed = await parseJsonBody(request, setupPatchSchema, {
    maxBytes: 1024,
    action: "setup.card.update",
    meta: { outcome: "validation_failed" },
    errorCode: "setup.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const cardDismissedAt = parsed.data.cardDismissed ? new Date() : null;
  await prisma.onboardingRecord.upsert({
    where: { userId: user.id },
    create: { userId: user.id, cardDismissedAt },
    update: { cardDismissedAt },
  });
  annotate({
    action: { name: "setup.card.update" },
    meta: { dismissed: parsed.data.cardDismissed },
  });

  return apiSuccess(
    await resolveSetupState(user.id, { browser: authMethod === "cookie" }),
  );
});
