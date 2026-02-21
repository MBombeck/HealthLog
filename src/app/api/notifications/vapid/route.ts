import { apiSuccess, apiError } from "@/lib/api-response";

/**
 * GET /api/notifications/vapid
 * Returns the VAPID public key for Web Push subscription.
 */
export async function GET() {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;

  if (!vapidPublicKey) {
    return apiError("Web Push is not configured", 503);
  }

  return apiSuccess({ publicKey: vapidPublicKey });
}
