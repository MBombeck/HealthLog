import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { requireModuleEnabled, resolveModuleMap } from "@/lib/modules/gate";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  buildAchievementsResult,
  type AchievementsResult,
} from "@/lib/gamification/achievements-result";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import type { NextRequest } from "next/server";

interface IosAchievement {
  id: string;
  key: string;
  title: string;
  description: string;
  iconName: string;
  unlocked: boolean;
  unlockedAt: string | null;
  progress: number;
  // v1.18.0 — parity fields the web payload already carries; the iOS
  // client needs them to group badges by category, render the points
  // tally, show absolute progress (current / target) and the opaque
  // hidden-card placeholder in lock-step with the web surface.
  category: string;
  points: number;
  target: number;
  current: number;
  isHidden: boolean;
}

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  // The record's badges. Every one of them is derived from the record's own
  // history — the metrics, the module map and the unlock dates all come off
  // the resolved account — so a delegate reads what the owner earned rather
  // than a copy of their own tally under the owner's name. Nothing here is a
  // preference of the person looking except the translation, and that resolves
  // per request from the caller's locale below.
  //
  // Admitted as an aggregate on the whole-record grant. The badge grid spans
  // every module that carries a badge category, so it joins the snapshot and
  // the digest in the set to re-examine if per-module scope ever lands.
  //
  // Read-only in fact as well as in declaration: v1.35.3 moved the unlock
  // INSERT onto the sweep job, so there is no write for a read grant to have
  // to refuse. `requireRecordAuth("read", "record")` would refuse a non-safe method
  // anyway; this file exports no other verb.
  const { user } = await requireRecordAuth("read", "record");

  // v1.18.0 — when the account has the achievements module turned off the
  // whole gamification surface disappears: no badge evaluation, no unlock
  // persistence, no payload. Returns the 403 `module.disabled` envelope
  // verbatim so the client (web + iOS) hides the page / dashboard tile /
  // unlock toast in lock-step with this refusal.
  const gate = await requireModuleEnabled(user.id, "achievements");
  if (!gate.enabled) {
    annotate({
      action: { name: "gamification.achievements" },
      meta: { moduleDisabled: true },
    });
    return gate.response;
  }

  const formatParam = request.nextUrl.searchParams.get("format");
  const isIosFormat = formatParam === "ios";
  annotate({
    action: { name: "gamification.achievements" },
    meta: { format: isIosFormat ? "ios" : "default" },
  });

  // v1.4.34 — cache the web-shape result keyed on userId. The
  // iOS-format branch runs the locale-aware transform after the cache
  // read so the cache stays format-agnostic and the achievement-progress
  // dashboard duplicate (seen twice per dashboard mount in the v1.4.33
  // HAR) coalesces into one builder call.
  // v1.18.0 — resolve the per-user module map once and pass it into the
  // builder so badge categories whose owning module is disabled (sleep
  // badges when sleep is off, mood badges when mood is off) are skipped
  // from evaluation AND unlock-persistence. Resolved outside the cache so
  // a toggle change is reflected on the next read.
  const moduleMap = await resolveModuleMap(user.id);

  // v1.18.11 — read via `cachedSwr`. The bucket carries a
  // 10-minute stale window; the app-wide `AchievementUnlockNotifier` polls
  // every 2 minutes, so a hard-TTL read always missed and re-paid the cold
  // build. SWR serves the prior payload instantly and warms one background
  // recompute.
  const result = await cachedSwr(
    caches.achievements as ServerCache<AchievementsResult>,
    user.id,
    () => buildAchievementsResult(user, moduleMap),
    annotate,
  );

  // v1.35.3 — the unlock rows are NOT written here. A GET must not have side
  // effects (`lib/auth/guards/context.ts`, the MCP-audience note above
  // `READ_HTTP_METHODS`), and this INSERT was one. The badge grid does not
  // need the rows: `unlocked` comes from the live metrics and the completion
  // date is derived from the account's own history, so the payload below is
  // identical whether or not a row exists. The rows pin that date against a
  // later data edit and carry it into the backup, which is durable work and
  // belongs on the `achievement-unlock-sweep` job — where it also covers the
  // accounts that never open this page.
  annotate({
    action: { name: "gamification.achievements" },
    meta: { pendingUnlocks: result.pendingUnlocks.length },
  });

  // Strip the internal `pendingUnlocks` carrier; it never goes on the wire.
  const payload = {
    summary: result.summary,
    achievements: result.achievements,
    metrics: result.metrics,
  };

  if (isIosFormat) {
    const locale = await resolveServerLocale({
      request,
      userLocale: user.locale,
    });
    const t = getServerTranslator(locale);
    const ios: IosAchievement[] = payload.achievements.map((a) => ({
      id: a.id,
      key: a.id,
      title: t.t(a.titleKey),
      description: t.t(a.descriptionKey),
      iconName: a.icon,
      unlocked: a.unlocked,
      unlockedAt: a.completedAt,
      progress: Math.max(0, Math.min(1, a.progressPercent / 100)),
      category: a.category,
      points: a.points,
      target: a.target,
      current: a.current,
      isHidden: a.isHidden,
    }));
    return apiSuccess(ios);
  }

  return apiSuccess(payload);
});
