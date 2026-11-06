/**
 * `GET /api/cycle/feed/<hlf_token>[.ics]` — the subscribable cycle forecast
 * (#1350).
 *
 * Anonymous by design: a calendar provider polls this URL from its own
 * servers, so the `hlf_` path segment is the only credential. Rate-limited
 * before the lookup, one blunt 404 for every miss, every gate re-read on each
 * fetch. The pipeline and its reasoning live in `serveCycleFeed`; this file
 * only binds it to the route.
 */
import { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { serveCycleFeed } from "@/lib/cycle/feed/serve";

type RouteParams = { params: Promise<{ token: string }> };

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { token } = await params;
    return serveCycleFeed(request, token);
  },
);
