import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { redactSecrets } from "@/lib/logging/redact";
import { getAuditLogRetentionDays } from "@/lib/jobs/audit-log-cleanup";
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { isoDateTime } from "@/lib/validations/datetime";

/**
 * v1.4.16: parse the union of legacy + new query params. Legacy
 * `limit`/`offset`/`filter` keys still work so the existing
 * `<RecentAuditPreview>` and `<LoginOverviewSection>` callers don't break;
 * new `page`/`perPage`/`actor`/`action`/`target`/`since`/`until` drive
 * the deepened admin viewer.
 */
const ALLOWED_PER_PAGE = [25, 50, 100] as const;
const ACTOR_MATCH_CAP = 100;

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
  since: isoDateTime({ offset: false }).optional(),
  until: isoDateTime({ offset: false }).optional(),
});

export const dynamic = "force-dynamic";

/**
 * Admin endpoint: list audit log entries.
 *
 * Filters (all optional, AND-combined):
 *   - actor    — substring match against `userId` OR `user.username`, and
 *                the same against the acting account (`actorUserId`)
 *   - action   — exact match (e.g. `auth.login.failed`)
 *   - target   — substring match against the JSON-encoded `details` field
 *   - since    — ISO-8601 lower bound on `createdAt`. Absent, the scan
 *                floors at the audit-log retention horizon so an
 *                open-ended sweep can't seqscan the table unbounded.
 *   - until    — ISO-8601 upper bound on `createdAt`
 *   - filter   — legacy shortcut: `auth` restricts to `auth.*` actions
 *
 * Pagination:
 *   - `page` + `perPage` (25/50/100; default 50). Out-of-range `perPage`
 *     falls back to the default rather than 400-ing so a stale UI never
 *     gets stuck on a request the server refuses.
 *   - Legacy `limit` + `offset` honored when present.
 *
 * Each entry carries `user` (the record the row is filed under) and `actor`
 * (who acted, when that is somebody else; null for a self-action).
 *
 * Response: `{ entries, meta: { total, page, perPage, limit, offset } }`.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();
  annotate({ action: { name: "admin.audit-log.list" } });

  const { searchParams } = new URL(request.url);
  const result = querySchema.safeParse({
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
  if (!result.success) return returnAllZodIssues(result.error);
  const parsed = result.data;

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
    // `actorUserId` is not a relation (see the schema comment), so a
    // username match on the acting account resolves to ids first. Capped:
    // a one-letter search must not turn into an unbounded IN list.
    const actingMatches = await prisma.user.findMany({
      where: { username: { contains: parsed.actor, mode: "insensitive" } },
      select: { id: true },
      take: ACTOR_MATCH_CAP,
    });
    ands.push({
      OR: [
        { userId: parsed.actor },
        {
          user: {
            username: { contains: parsed.actor, mode: "insensitive" },
          },
        },
        { actorUserId: parsed.actor },
        ...(actingMatches.length > 0
          ? [{ actorUserId: { in: actingMatches.map((u) => u.id) } }]
          : []),
      ],
    });
  }

  if (parsed.target) {
    // `details` is a JSON-encoded string column, so a substring match on
    // the raw text is the cheapest cross-field "target" filter.
    ands.push({ details: { contains: parsed.target } });
  }

  // Bound the lower edge of the scan. `actor`/`target` are substring
  // matches (seqscans) and the exact `count` below runs a second pass over
  // the same predicate, so an open-ended history sweep on this admin-only,
  // low-frequency surface would scan the table twice with no floor. The
  // cleanup job already prunes rows past the retention horizon, so aligning
  // the default floor to that same horizon bounds both passes without ever
  // hiding a row the deployment still keeps. An explicit `since` overrides.
  const lowerBound = parsed.since
    ? new Date(parsed.since)
    : new Date(Date.now() - getAuditLogRetentionDays() * 86_400_000);
  const createdAt: { gte: Date; lte?: Date } = { gte: lowerBound };
  if (parsed.until) createdAt.lte = new Date(parsed.until);

  // Keep `createdAt` a top-level sibling of the optional filter clause so a
  // single substring/exact filter stays flat (no `AND` wrapper); the
  // collapse below only folds the independent filter `ands` entries.
  const filterWhere: Record<string, unknown> =
    ands.length === 0 ? {} : ands.length === 1 ? ands[0] : { AND: ands };
  const where: Record<string, unknown> = { ...filterWhere, createdAt };

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
        // v1.4.27 — surface the carrier chip data alongside the
        // existing location string. Both nullable so older rows render
        // with the same dash that `location` falls back to.
        asn: true,
        carrier: true,
        details: true,
        createdAt: true,
        actorUserId: true,
        user: {
          select: { id: true, username: true },
        },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  // v1.4.16 (security H2) — `details` is a JSON string
  // column written by `auditLog()` calls across the app. A user-controlled
  // value can land in here (e.g. `auth.login.failed → details.identifier`)
  // and a typo'd "Bearer hlk_..." in a username field would otherwise be
  // shown verbatim in the admin viewer + CSV export. Run the redaction
  // pass at egress so already-persisted rows are scrubbed too.
  //
  // #1403 — a row a guardian (or any delegate) wrote inside another record
  // is filed under that record, with the person who acted in `actorUserId`.
  // Without it the viewer named only the record, so a guardian's upload
  // read as the profile's own. The actor is resolved to the same
  // `{ id, username }` the row already shows for `user`, nothing more; an
  // id that no longer resolves (the account was deleted) keeps its id with
  // a null username so the viewer can say so instead of dropping the actor.
  const actorIds = [
    ...new Set(
      entries
        .map((entry) => entry.actorUserId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const actors =
    actorIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, username: true },
        });
  const usernameById = new Map(actors.map((u) => [u.id, u.username]));

  const redactedEntries = entries.map(({ actorUserId, ...entry }) => ({
    ...entry,
    details: entry.details ? redactSecrets(entry.details) : entry.details,
    actor:
      actorUserId === null
        ? null
        : { id: actorUserId, username: usernameById.get(actorUserId) ?? null },
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
