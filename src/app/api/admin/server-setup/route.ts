/**
 * 1.49 — the first-admin server setup's state.
 *
 *  GET   /api/admin/server-setup   the steps, the finish stamp, whether the
 *                                  start-page notice shows for this admin, and
 *                                  the environment facts the steps show
 *                                  (booleans and variable names, never values)
 *  PATCH /api/admin/server-setup   `{ step, status: "done" | "skipped" }`:
 *                                  record one step; the last settled step
 *                                  stamps the setup finished
 *
 * `requireAdmin()` is cookie-only, so a Bearer token (even a wildcard one) and
 * a delegate are refused. The steps' settings are saved by their own admin
 * routes; this route only records the step. A demo deploy offers no setup and
 * refuses the write.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  readServerSetupState,
  serverSetupOfferedHere,
  writeServerSetupStep,
} from "@/lib/admin/server-setup-store";
import { serverSetupStepPatchSchema } from "@/lib/validations/server-setup";

export const dynamic = "force-dynamic";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 10 * 60 * 1000;

export const GET = apiHandler(async () => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.server_setup.get" } });
  return apiSuccess(await readServerSetupState(user.id));
});

export const PATCH = apiHandler(async (request: Request) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.server_setup.step" } });

  if (!serverSetupOfferedHere()) {
    return apiError("The server setup is not offered on this server", 409, {
      errorCode: "admin.serverSetup.notOffered",
    });
  }

  const rl = await checkRateLimit(
    `admin-server-setup:${user.id}`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many setup writes, try again later", 429, {
      errorCode: "admin.serverSetup.rateLimited",
    });
  }

  const parsed = await parseJsonBody(request, serverSetupStepPatchSchema, {
    maxBytes: 1024,
    action: "admin.server_setup.step",
    meta: { outcome: "validation_failed" },
    errorCode: "admin.serverSetup.invalid",
  });
  if (!parsed.ok) return parsed.error;

  await writeServerSetupStep(parsed.data.step, parsed.data.status);
  const state = await readServerSetupState(user.id);

  await auditLog("admin.server-setup.step", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      step: parsed.data.step,
      status: parsed.data.status,
      completed: state.completedAt !== null,
    },
  });
  annotate({
    action: { name: "admin.server_setup.step" },
    meta: {
      step: parsed.data.step,
      status: parsed.data.status,
      completed: state.completedAt !== null,
    },
  });

  return apiSuccess(state);
});
