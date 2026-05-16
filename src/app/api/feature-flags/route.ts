/**
 * `GET /api/feature-flags` — operator-side assistant flag matrix.
 *
 * Projects `AppSettings.assistant*Enabled` over HTTP so every client
 * (web React tree + iOS native) reads the same authoritative shape.
 *
 * Response envelope:
 *
 *   {
 *     "data": {
 *       "assistant": {
 *         "enabled": true,
 *         "coach": true,
 *         "briefing": true,
 *         "insightStatus": true,
 *         "correlations": true,
 *         "healthScoreExplainer": true
 *       }
 *     },
 *     "error": null
 *   }
 *
 * - `requireAuth()` — any logged-in user. Per-request flag fetches
 *   from the iOS native client always arrive after auth, so the
 *   gate matches the rest of the read-only profile surface.
 * - Master kills every sub-flag in the resolver before the shape
 *   leaves the handler, so callers never have to compose
 *   `master && sub`.
 * - `Cache-Control: private, max-age=60` — operator toggles flip
 *   rarely; a 60-second per-session cache keeps the cost off the
 *   hot /insights mount path while still propagating an admin
 *   change within a minute.
 *
 * Locked per `.planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md` §3 R5
 * and `.planning/research/v15-assistant-optional.md` Part D.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { getAssistantFlags } from "@/lib/feature-flags";
import { annotate } from "@/lib/logging/context";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const GET = apiHandler(async (_request: NextRequest) => {
  await requireAuth();
  annotate({ action: { name: "feature-flags.read" } });

  const assistant = await getAssistantFlags();

  const response = apiSuccess({ assistant });
  response.headers.set("Cache-Control", "private, max-age=60");
  return response;
});
