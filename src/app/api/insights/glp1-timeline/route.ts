/**
 * v1.4.25 W4d — GLP-1 therapy-timeline aggregator.
 *
 * Returns a chronological merge of every GLP-1-relevant event the user
 * has logged: dose changes, injections (with site if recorded),
 * inventory events, and side-effect-tagged mood entries from the
 * trailing 90 days. Used by /insights/medications' TherapyTimeline
 * component. Web-only users without a GLP-1 medication get
 * `hasGlp1: false` so the component hides cleanly.
 */

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { NextRequest } from "next/server";

const DEFAULT_LIMIT = 60;
const SIDE_EFFECT_TAGS = new Set([
  "nausea",
  "constipation",
  "diarrhea",
  "fatigue",
  "appetite-loss",
  "heartburn",
  "headache",
  "übelkeit",
  "verstopfung",
  "durchfall",
  "müdigkeit",
  "appetitlosigkeit",
  "sodbrennen",
  "kopfschmerzen",
]);

interface TimelineEntry {
  date: string;
  kind: "dose-change" | "injection" | "inventory" | "side-effect";
  medicationName?: string;
  doseValue?: number;
  doseUnit?: string;
  doseDelta?: "up" | "down" | null;
  note?: string | null;
  injectionSite?: string | null;
  inventoryDelta?: number;
  reason?: string;
  tags?: string[];
}

function parseTagList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter(Boolean);
    }
  } catch {
    /* fall through */
  }
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 200
      ? rawLimit
      : DEFAULT_LIMIT;

  const meds = await prisma.medication.findMany({
    where: { userId: user.id, treatmentClass: "GLP1" },
    include: {
      doseChanges: { orderBy: { effectiveFrom: "asc" } },
      intakeEvents: {
        where: { takenAt: { not: null } },
        orderBy: { takenAt: "desc" },
        take: 50,
      },
      inventoryEvents: { orderBy: { occurredAt: "desc" }, take: 20 },
    },
  });

  if (meds.length === 0) {
    return apiSuccess({ hasGlp1: false, entries: [] });
  }

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const moods = await prisma.moodEntry.findMany({
    // v1.7.0 sync — exclude tombstoned rows.
    where: { userId: user.id, deletedAt: null, moodLoggedAt: { gte: ninetyDaysAgo } },
    select: { moodLoggedAt: true, tags: true },
    orderBy: { moodLoggedAt: "desc" },
  });

  const entries: TimelineEntry[] = [];

  for (const med of meds) {
    const sortedChanges = [...med.doseChanges];
    for (let i = 0; i < sortedChanges.length; i += 1) {
      const dc = sortedChanges[i];
      const prev = i > 0 ? sortedChanges[i - 1] : null;
      let delta: "up" | "down" | null = null;
      if (prev) {
        if (dc.doseValue > prev.doseValue) delta = "up";
        else if (dc.doseValue < prev.doseValue) delta = "down";
      }
      entries.push({
        date: dc.effectiveFrom.toISOString(),
        kind: "dose-change",
        medicationName: med.name,
        doseValue: dc.doseValue,
        doseUnit: dc.doseUnit,
        doseDelta: delta,
        note: dc.note,
      });
    }
    for (const intake of med.intakeEvents) {
      if (!intake.takenAt) continue;
      entries.push({
        date: intake.takenAt.toISOString(),
        kind: "injection",
        medicationName: med.name,
        injectionSite: intake.injectionSite,
      });
    }
    for (const inv of med.inventoryEvents) {
      entries.push({
        date: inv.occurredAt.toISOString(),
        kind: "inventory",
        medicationName: med.name,
        inventoryDelta: inv.delta,
        reason: inv.reason,
      });
    }
  }

  // Side-effect days — collapse to one entry per day (most recent
  // first) listing every recognised tag picked up that day.
  const sideEffectByDay = new Map<string, string[]>();
  for (const mood of moods) {
    const tags = parseTagList(mood.tags).filter((t) =>
      SIDE_EFFECT_TAGS.has(t.toLowerCase()),
    );
    if (tags.length === 0) continue;
    const dayKey = mood.moodLoggedAt.toISOString().slice(0, 10);
    const existing = sideEffectByDay.get(dayKey) ?? [];
    for (const t of tags) {
      if (!existing.includes(t)) existing.push(t);
    }
    sideEffectByDay.set(dayKey, existing);
  }
  for (const [day, tags] of sideEffectByDay) {
    entries.push({
      date: `${day}T12:00:00Z`,
      kind: "side-effect",
      tags,
    });
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));

  return apiSuccess({ hasGlp1: true, entries: entries.slice(0, limit) });
});
