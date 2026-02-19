import { getSession } from "@/lib/auth/session";
import { apiError } from "@/lib/api-response";
import { getAuthorizationUrl } from "@/lib/withings/client";
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Redirects the user to Withings OAuth authorization page.
 * State param = userId:random for CSRF protection.
 */
export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const stateNonce = randomBytes(16).toString("hex");
  const state = `${sessionData.user.id}:${stateNonce}`;

  // Store state in a short-lived cookie for validation
  const url = getAuthorizationUrl(state);

  const response = NextResponse.redirect(url);
  response.cookies.set("withings_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // Lax needed for OAuth redirect
    maxAge: 600, // 10 minutes
    path: "/",
  });

  return response;
}
