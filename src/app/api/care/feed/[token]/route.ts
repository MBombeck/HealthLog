/**
 * `GET /api/care/feed/<hlf_token>[.ics]` — the subscribable care dates:
 * booked visits, check-ups and vaccination boosters coming due.
 *
 * Anonymous by design: a calendar provider polls this URL from its own
 * servers, so the `hlf_` path segment is the only credential. Rate-limited
 * before the lookup, one blunt 404 for every miss, every gate re-read on each
 * fetch. The pipeline lives in `serveCareFeed`; this file binds it.
 */
import { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { serveCareFeed } from "@/lib/care-feed/serve";

type RouteParams = { params: Promise<{ token: string }> };

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { token } = await params;
    return serveCareFeed(request, token);
  },
);
