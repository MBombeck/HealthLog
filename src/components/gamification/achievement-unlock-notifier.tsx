"use client";

import { Sparkles, Trophy } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/lib/i18n/context";
import { useAchievementsQuery } from "@/lib/queries/use-achievements-query";

const STORAGE_KEY_PREFIX = "healthlog-achievements-seen";

interface AchievementUnlockNotifierProps {
  userId: string;
}

function parseStoredIds(raw: string | null): Set<string> {
  if (!raw) return new Set();

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return new Set();
  }
}

function readSeenIds(storageKey: string): {
  seenIds: Set<string>;
  hasSnapshot: boolean;
} {
  try {
    const raw = localStorage.getItem(storageKey);
    return {
      seenIds: parseStoredIds(raw),
      hasSnapshot: raw !== null,
    };
  } catch {
    return {
      seenIds: new Set<string>(),
      hasSnapshot: true,
    };
  }
}

function writeSeenIds(storageKey: string, seenIds: Set<string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(Array.from(seenIds)));
  } catch {
    // Ignore storage failures (privacy mode / quota) and keep notifier in-memory.
  }
}

export function AchievementUnlockNotifier({
  userId,
}: AchievementUnlockNotifierProps) {
  const { t } = useTranslations();
  const storageKey = useMemo(() => `${STORAGE_KEY_PREFIX}:${userId}`, [userId]);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const localStateReadyRef = useRef(false);
  const hasSnapshotRef = useRef(false);

  // v1.4.34 IW-F-Perf — the notifier and `<RecentAchievementsCard>`
  // both ride the shared `["gamification", "achievements"]` cache cell.
  // Before, the notifier carried a per-user discriminator on its key,
  // which made TanStack treat it as a fresh cell and fire a second
  // network call alongside the dashboard tile. The shared hook owns the
  // refetch cadence; the notifier supplies the polling interval so
  // long-open tabs still surface new unlocks without forcing the card
  // to re-render on the same cadence.
  const { data } = useAchievementsQuery({
    refetchInterval: 2 * 60 * 1000,
  });

  useEffect(() => {
    const state = readSeenIds(storageKey);
    seenIdsRef.current = state.seenIds;
    hasSnapshotRef.current = state.hasSnapshot;
    localStateReadyRef.current = true;
  }, [storageKey]);

  useEffect(() => {
    if (!localStateReadyRef.current || !data) return;

    const unlocked = data.achievements.filter(
      (achievement) => achievement.unlocked,
    );
    const unlockedIds = unlocked.map((achievement) => achievement.id);

    if (!hasSnapshotRef.current) {
      seenIdsRef.current = new Set(unlockedIds);
      writeSeenIds(storageKey, seenIdsRef.current);
      hasSnapshotRef.current = true;
      return;
    }

    const newlyUnlocked = unlocked.filter(
      (achievement) => !seenIdsRef.current.has(achievement.id),
    );

    if (newlyUnlocked.length === 0) {
      return;
    }

    for (const achievement of newlyUnlocked) {
      // v1.4.18 — hidden Easter-eggs get a celebration toast that
      // names them "hidden". The real title/description are revealed
      // *only* on the unlock toast (and afterwards on the unlocked
      // card) so the surprise lands.
      if (achievement.isHidden) {
        toast(t("achievements.hiddenUnlockToast.title"), {
          description: `${t(achievement.titleKey)} — ${t(achievement.descriptionKey)}`,
          icon: <Sparkles className="size-4" />,
          duration: 8000,
        });
      } else {
        toast(t(achievement.titleKey), {
          description: t(achievement.descriptionKey),
          icon: <Trophy className="size-4" />,
        });
      }
      seenIdsRef.current.add(achievement.id);
    }

    writeSeenIds(storageKey, seenIdsRef.current);
  }, [data, storageKey, t]);

  return null;
}
