"use client";

import { useQuery } from "@tanstack/react-query";
import { Trophy } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/lib/i18n/context";
import type { AchievementProgress } from "@/lib/gamification/achievements";

const STORAGE_KEY_PREFIX = "healthlog-achievements-seen";

interface AchievementsPayload {
  achievements: AchievementProgress[];
}

interface AchievementUnlockNotifierProps {
  userId: string;
}

function parseStoredIds(raw: string | null): Set<string> {
  if (!raw) return new Set();

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function readSeenIds(storageKey: string): { seenIds: Set<string>; hasSnapshot: boolean } {
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
  const storageKey = useMemo(
    () => `${STORAGE_KEY_PREFIX}:${userId}`,
    [userId],
  );
  const seenIdsRef = useRef<Set<string>>(new Set());
  const localStateReadyRef = useRef(false);
  const hasSnapshotRef = useRef(false);

  const { data } = useQuery({
    queryKey: ["gamification", "achievements", "unlock-notifier", userId],
    queryFn: async () => {
      try {
        const response = await fetch("/api/gamification/achievements");
        if (!response.ok) {
          return { achievements: [] } satisfies AchievementsPayload;
        }
        const json = await response.json();
        return (json.data ?? { achievements: [] }) as AchievementsPayload;
      } catch {
        return { achievements: [] } satisfies AchievementsPayload;
      }
    },
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const state = readSeenIds(storageKey);
    seenIdsRef.current = state.seenIds;
    hasSnapshotRef.current = state.hasSnapshot;
    localStateReadyRef.current = true;
  }, [storageKey]);

  useEffect(() => {
    if (!localStateReadyRef.current || !data) return;

    const unlocked = data.achievements.filter((achievement) => achievement.unlocked);
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
      toast(t(achievement.titleKey), {
        description: t(achievement.descriptionKey),
        icon: <Trophy className="size-4" />,
      });
      seenIdsRef.current.add(achievement.id);
    }

    writeSeenIds(storageKey, seenIdsRef.current);
  }, [data, storageKey, t]);

  return null;
}
