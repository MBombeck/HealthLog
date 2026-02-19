import { getSession } from "@/lib/auth/session";
import { apiError } from "@/lib/api-response";
import { getAuthorizationUrl } from "@/lib/withings/client";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Redirects the user to Withings OAuth authorization page.
 * State param = userId:random for CSRF protection.
 */
export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const creds = await getUserWithingsCredentials(sessionData.user.id);
  if (!creds) {
    return apiError(
      "Bitte zuerst Withings Client-ID und Client-Secret in den Einstellungen hinterlegen.",
      400,
    );
  }

  const stateNonce = randomBytes(16).toString("hex");
  const state = `${sessionData.user.id}:${stateNonce}`;

  const url = getAuthorizationUrl(state, creds);

  const response = NextResponse.redirect(url);
  response.cookies.set("withings_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return response;
}
