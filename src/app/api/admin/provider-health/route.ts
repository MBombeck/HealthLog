import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { buildDateKey } from "@/lib/ai/coach/budget";
import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

/**
 * v1.37.31 — per-provider delivery health for the operator.
 *
 * The per-user retry ledger (`provider_health`) has recorded every AI
 * delivery outcome for a long time, but no surface ever read it for the
 * operator: a central provider (`admin-openai` / `admin-codex`) could fail
 * on every call for weeks and the admin console said nothing. This endpoint
 * folds the ledger into one row per provider type so the console can show
 * it. Read-only, admin-cookie-only, and it exposes counts and timestamps
 * only — never which user a row belongs to.
 *
 * The ledger also records the HTTP status each failure came back with, and
 * that is the difference between the two questions an operator actually has
 * when a provider goes red: a 401 means the key is dead and only the operator
 * can fix it, a 429 or a 5xx means the provider is having a day and waiting is
 * the right move. The fold carries it beside the instant it belongs to.
 */

interface ProviderHealthSummary {
  providerType: string;
  /** Users whose chain has recorded at least one outcome for this type. */
  tracked: number;
  /** Users whose LAST outcome for this type was a failure. */
  failing: number;
  /** Highest uninterrupted failure run across those users. */
  maxConsecutiveFailures: number;
  lastOkAt: string | null;
  lastFailureAt: string | null;
  /**
   * HTTP status the failure at `lastFailureAt` came back with. Null when
   * that failure was a network-class one (no response to read a status
   * from), and null when the user it belongs to has since recovered — a
   * success clears the status along with the rest of the failure state.
   */
  lastFailureStatus: number | null;
}

/** The two operator-managed tags sort first — they affect every user on the chain. */
const CENTRAL_TYPES = ["admin-openai", "admin-codex"];

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.provider-health.get" } });

  // The UTC day the ledger buckets by — the same key every reservation writes.
  const dateKey = buildDateKey();

  const groups = await prisma.providerHealth.groupBy({
    // `lastStatus` joins the grouping key rather than an aggregate: the
    // MAX of two HTTP statuses is not a status, it is arithmetic on a
    // label. Grouping by it splits each result bucket per status and the
    // fold below picks the one belonging to the newest failure.
    by: ["providerType", "lastResult", "lastStatus"],
    _count: { _all: true },
    _max: {
      consecutiveFailures: true,
      lastFailureAt: true,
      lastOkAt: true,
    },
  });

  const byType = new Map<string, ProviderHealthSummary>();
  for (const g of groups) {
    const row = byType.get(g.providerType) ?? {
      providerType: g.providerType,
      tracked: 0,
      failing: 0,
      maxConsecutiveFailures: 0,
      lastOkAt: null,
      lastFailureAt: null,
      lastFailureStatus: null,
    };
    row.tracked += g._count._all;
    if (g.lastResult !== "ok") {
      row.failing += g._count._all;
      row.maxConsecutiveFailures = Math.max(
        row.maxConsecutiveFailures,
        g._max.consecutiveFailures ?? 0,
      );
    }
    const ok = g._max.lastOkAt?.toISOString() ?? null;
    if (ok && (!row.lastOkAt || ok > row.lastOkAt)) row.lastOkAt = ok;
    const fail = g._max.lastFailureAt?.toISOString() ?? null;
    if (fail && (!row.lastFailureAt || fail > row.lastFailureAt)) {
      row.lastFailureAt = fail;
      // Tied to the instant, not taken from whichever group happens to
      // have one: a status that describes a different failure than the
      // one on screen is worse than no status at all.
      row.lastFailureStatus = g.lastStatus;
    }
    byType.set(g.providerType, row);
  }

  const providers = [...byType.values()].sort((a, b) => {
    const ca = CENTRAL_TYPES.indexOf(a.providerType);
    const cb = CENTRAL_TYPES.indexOf(b.providerType);
    if (ca !== -1 || cb !== -1) {
      return (
        (ca === -1 ? CENTRAL_TYPES.length : ca) -
        (cb === -1 ? CENTRAL_TYPES.length : cb)
      );
    }
    return a.providerType.localeCompare(b.providerType);
  });

  // v1.38.19 (Wave E) — the day's spend, split by who pays for it.
  //
  // The operator opens this card when a surface refuses on budget. One mixed
  // number could not answer the question it raised: a day at 1.24 M tokens is
  // alarming until you see that 151 200 of them were the instance's own key
  // and the rest ran on the users' plans. The operator ceiling is enforced
  // against the second figure, so both belong on screen.
  const spend = await prisma.coachUsage.aggregate({
    where: { dateKey },
    _sum: { totalTokens: true, operatorTokens: true },
  });

  return apiSuccess({
    providers,
    spendToday: {
      dateKey,
      totalTokens: spend._sum.totalTokens ?? 0,
      operatorTokens: spend._sum.operatorTokens ?? 0,
    },
  });
});
