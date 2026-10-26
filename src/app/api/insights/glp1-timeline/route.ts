/**
 * v1.4.25 — GLP-1 therapy-timeline aggregator.
 *
 * Returns a chronological merge of every GLP-1-relevant event the user
 * has logged: dose changes, injections (with site if recorded),
 * inventory events, and side-effect-tagged mood entries from the
 * trailing 90 days. Used by /insights/medications' TherapyTimeline
 * component. Web-only users without a GLP-1 medication get
 * `hasGlp1: false` so the component hides cleanly.
 */

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { readNote } from "@/lib/crypto/note-cipher";
import { annotate } from "@/lib/logging/context";
import { matchGlp1SideEffectTags } from "@/lib/medications/glp1-side-effect-tag-match";
import type { Glp1SideEffectTag } from "@/lib/medications/glp1-side-effect-tags";
import { NextRequest } from "next/server";

const DEFAULT_LIMIT = 60;

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
  tags?: Glp1SideEffectTag[];
}

export const GET = apiHandler(async (request: NextRequest) => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 200
      ? rawLimit
      : DEFAULT_LIMIT;

  const meds = await prisma.medication.findMany({
    where: { userId: user.id, treatmentClass: "GLP1" },
    include: {
      doseChanges: { orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }] },
      intakeEvents: {
        where: { takenAt: { not: null } },
        orderBy: [{ takenAt: "desc" }, { id: "desc" }],
        take: 50,
      },
      // v1.16.10 divergence note: the stock READOUTS (glp1 details
      // endpoint, Coach snapshot) moved to the per-item
      // MedicationInventoryItem entities, but this timeline renders the
      // append-only MedicationInventoryEvent LEDGER as point-in-time
      // entries ("+2 pens purchased") — a per-item swap is not
      // mechanical (items carry no per-mutation history). The ledger
      // only grows through the legacy `POST /api/medications/[id]/glp1`
      // inventory branch, so timelines on item-tracked medications show
      // no new inventory entries.
      inventoryEvents: {
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 20,
      },
    },
  });

  if (meds.length === 0) {
    return apiSuccess({ hasGlp1: false, entries: [], medications: [] });
  }

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const moods = await prisma.moodEntry.findMany({
    // v1.7.0 sync — exclude tombstoned rows.
    where: {
      userId: user.id,
      deletedAt: null,
      moodLoggedAt: { gte: ninetyDaysAgo },
    },
    select: { date: true, tags: true },
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
        note: readNote(dc.noteEncrypted, dc.note),
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

  // Side-effect days — collapse to one entry per day (most recent first)
  // listing every catalogue side effect picked up that day.
  //
  // `tags` carries the catalogue KEY, not the string the entry was written
  // with. The chip writes the label of whatever language the writer's UI was
  // in, so the stored column mixes languages within one account the moment
  // somebody switches locale; a key renders in the reader's language and a
  // stored label renders in the writer's.
  const sideEffectByDay = new Map<string, Glp1SideEffectTag[]>();
  let unresolvedTagCount = 0;
  for (const mood of moods) {
    const { matched, unresolvedCount } = matchGlp1SideEffectTags(mood.tags);
    unresolvedTagCount += unresolvedCount;
    if (matched.length === 0) continue;
    // `date` is the day the entry belongs to in the writer's zone. The UTC
    // day of `moodLoggedAt` moved an evening entry west of UTC (a morning
    // one east of it) onto the neighbouring day.
    const dayKey = mood.date;
    const existing = sideEffectByDay.get(dayKey) ?? [];
    for (const t of matched) {
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

  // Mood tags that are not catalogue side effects are correctly absent from a
  // GLP-1 timeline — they are the user's own prose about their day, and this
  // surface is not where it belongs. Absent is not the same as untracked
  // though: the count rides the wide event so the classification rate stays
  // answerable from a dashboard, without the text leaving the database.
  annotate({
    action: { name: "insights.glp1-timeline.read" },
    meta: {
      side_effect_days: sideEffectByDay.size,
      unresolved_mood_tags: unresolvedTagCount,
    },
  });

  // `medications` is every GLP-1 medication, independent of `limit`: a
  // consumer that needs the set (the substance-curve summary) must not
  // derive it from a capped page of entries.
  return apiSuccess({
    hasGlp1: true,
    entries: entries.slice(0, limit),
    medications: meds.map((med) => ({ id: med.id, name: med.name })),
  });
});
