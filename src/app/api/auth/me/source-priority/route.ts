/**
 * v1.4.25 W5e — per-user, per-metric-class source priority.
 *
 *  GET  /api/auth/me/source-priority  — returns the fully-defaulted
 *                                       shape (missing keys filled
 *                                       from `DEFAULT_SOURCE_PRIORITY`).
 *  PUT  /api/auth/me/source-priority  — replaces the persisted shape;
 *                                       body is validated against
 *                                       `sourcePrioritySchema` and
 *                                       persisted as the partial form
 *                                       (missing keys keep the default
 *                                       at read time).
 *
 * Bearer-auth + cookie-auth both work via the shared `requireAuth()`
 * helper. The analytics aggregator reads this row on every call and
 * the read path is cheap (one column) — no caching layer to flush.
 */
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import {
  parseSourcePriority,
  sourcePrioritySchema,
} from "@/lib/validations/source-priority";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.source-priority.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { sourcePriorityJson: true },
  });
  return apiSuccess(parseSourcePriority(row?.sourcePriorityJson));
});

export const PUT = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(422, "source-priority.body.invalid_json");
  }

  const parsed = sourcePrioritySchema.safeParse(body ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.source-priority.put.invalid" },
      meta: { issues: parsed.error.issues.length },
    });
    throw new HttpError(422, "source-priority.body.invalid_shape");
  }

  // Persist the partial form — missing keys read as defaults via
  // `parseSourcePriority`. Storing only the user-edited subset keeps
  // the Json blob narrow and future-proofs the shape: when a new
  // metric class is added, every existing row reads the new key's
  // default until the user explicitly changes it.
  await prisma.user.update({
    where: { id: user.id },
    data: { sourcePriorityJson: parsed.data },
  });

  annotate({
    action: { name: "auth.me.source-priority.put" },
    meta: { keys: Object.keys(parsed.data).length },
  });
  return apiSuccess(parseSourcePriority(parsed.data));
});
