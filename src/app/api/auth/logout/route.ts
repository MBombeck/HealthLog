import { destroySession } from "@/lib/auth/session";
import { apiSuccess } from "@/lib/api-response";

export async function POST() {
  await destroySession();
  return apiSuccess({ loggedOut: true });
}
