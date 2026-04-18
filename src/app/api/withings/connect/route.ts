import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { getAuthorizationUrl } from "@/lib/withings/client";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Redirects the user to Withings OAuth authorization page.
 * State param = userId:random for CSRF protection.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.connect" } });

  const creds = await getUserWithingsCredentials(user.id);
  if (!creds) {
    return apiError(
      "Please configure your Withings Client ID and Client Secret in Settings first.",
      400,
    );
  }

  const stateNonce = randomBytes(16).toString("hex");
  const state = `${user.id}:${stateNonce}`;

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
});
