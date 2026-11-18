/**
 * POST /api/antigravity/auth/cancel
 *
 * Cancels and terminates any active interactive login session for the user.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { cancelAntigravityLogin } from "@/lib/ai/antigravity-auth-session";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { user: caller } = await requireAuth();

  cancelAntigravityLogin(caller.id);

  return apiSuccess({ success: true });
});
