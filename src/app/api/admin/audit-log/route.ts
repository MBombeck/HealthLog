import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { redactSecrets } from "@/lib/logging/redact";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * v1.4.16 phase B4: parse the union of legacy + new query params. Legacy
 * `limit`/`offset`/`filter` keys still work so the existing
 * `<RecentAuditPreview>` and `<LoginOverviewSection>` callers don't break;
 * new `page`/`perPage`/`actor`/`action`/`target`/`since`/`until` drive
 * the deepened admin viewer.
 */
const ALLOWED_PER_PAGE = [25, 50, 100] as const;

const querySchema = z.object({
  // Legacy
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  filter: z.enum(["auth", "all"]).optional(),
  // New
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().optional(),
  actor: z.string().trim().min(1).max(200).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  target: z.string().trim().min(1).max(200).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

export const dynamic = "force-dynamic";

/**
 * Admin endpoint: list audit log entries.
 *
 * Filters (all optional, AND-combined):
 *   - actor    — substring match against `userId` OR `user.username`
 *   - action   — exact match (e.g. `auth.login.failed`)
 *   - target   — substring match against the JSON-encoded `details` field
 *   - since    — ISO-8601 lower bound on `createdAt`
 *   - until    — ISO-8601 upper bound on `createdAt`
 *   - filter   — legacy shortcut: `auth` restricts to `auth.*` actions
 *
 * Pagination:
 *   - `page` + `perPage` (25/50/100; default 50). Out-of-range `perPage`
 *     falls back to the default rather than 400-ing so a stale UI never
 *     gets stuck on a request the server refuses.
 *   - Legacy `limit` + `offset` honored when present.
 *
 * Response: `{ entries, meta: { total, page, perPage, limit, offset } }`.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();
  annotate({ action: { name: "admin.audit-log.list" } });

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.parse({
    limit: searchParams.get("limit") ?? undefined,
    offset: searchParams.get("offset") ?? undefined,
    filter: searchParams.get("filter") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    perPage: searchParams.get("perPage") ?? undefined,
    actor: searchParams.get("actor") ?? undefined,
    action: searchParams.get("action") ?? undefined,
    target: searchParams.get("target") ?? undefined,
    since: searchParams.get("since") ?? undefined,
    until: searchParams.get("until") ?? undefined,
  });

  // Resolve perPage: clamp to allowed set, fall back to 50.
  const perPageResolved =
    parsed.perPage !== undefined &&
    (ALLOWED_PER_PAGE as readonly number[]).includes(parsed.perPage)
      ? parsed.perPage
      : 50;

  // Pagination: legacy `limit`/`offset` win when present so the existing
  // callers (preview component, login-overview filter buttons) keep their
  // exact behaviour. Otherwise derive from `page`/`perPage`.
  const take = parsed.limit ?? perPageResolved;
  const skip =
    parsed.limit !== undefined
      ? parsed.offset
      : (parsed.page - 1) * perPageResolved;

  // Build the WHERE filter compositionally so each filter is independent.
  const ands: Record<string, unknown>[] = [];

  if (parsed.filter === "auth") {
    ands.push({ action: { startsWith: "auth." } });
  }

  if (parsed.action) {
    ands.push({ action: parsed.action });
  }

  if (parsed.actor) {
    ands.push({
      OR: [
        { userId: parsed.actor },
        {
          user: {
            username: { contains: parsed.actor, mode: "insensitive" },
          },
        },
      ],
    });
  }

  if (parsed.target) {
    // `details` is a JSON-encoded string column, so a substring match on
    // the raw text is the cheapest cross-field "target" filter.
    ands.push({ details: { contains: parsed.target } });
  }

  if (parsed.since || parsed.until) {
    const range: { gte?: Date; lte?: Date } = {};
    if (parsed.since) range.gte = new Date(parsed.since);
    if (parsed.until) range.lte = new Date(parsed.until);
    ands.push({ createdAt: range });
  }

  const where: Record<string, unknown> | undefined =
    ands.length === 0 ? undefined : ands.length === 1 ? ands[0] : { AND: ands };

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      select: {
        id: true,
        action: true,
        ipAddress: true,
        location: true,
        // v1.4.27 B3 — surface the carrier chip data alongside the
        // existing location string. Both nullable so older rows render
        // with the same dash that `location` falls back to.
        asn: true,
        carrier: true,
        details: true,
        createdAt: true,
        user: {
          select: { id: true, username: true },
        },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  // v1.4.16 phase D reconcile (security H2) — `details` is a JSON string
  // column written by `auditLog()` calls across the app. A user-controlled
  // value can land in here (e.g. `auth.login.failed → details.identifier`)
  // and a typo'd "Bearer hlk_..." in a username field would otherwise be
  // shown verbatim in the admin viewer + CSV export. Run the redaction
  // pass at egress so already-persisted rows are scrubbed too.
  const redactedEntries = entries.map((entry) => ({
    ...entry,
    details: entry.details ? redactSecrets(entry.details) : entry.details,
  }));

  return apiSuccess({
    entries: redactedEntries,
    meta: {
      total,
      // Both shapes returned so old callers keep working.
      limit: take,
      offset: skip,
      page: parsed.page,
      perPage: perPageResolved,
    },
  });
});
