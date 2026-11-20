/**
 * The read behind the `SYMPTOM:<definitionId>` correlation channels: which
 * active symptoms become channels, and their occurrences in the window.
 * The channel fetcher in `src/lib/insights/correlation-channel-series.ts`
 * names and shapes them.
 */
import { prisma } from "@/lib/db";
import { pickCorrelationSymptoms } from "@/lib/symptoms/server";

/**
 * The chosen symptoms in pick order (`pickCorrelationSymptoms`: the most
 * logged in the window, at most `MAX_SYMPTOM_CORRELATION_CHANNELS`), each
 * with its encrypted name and its occurrences since `since`, newest first.
 */
export async function readCorrelationSymptomEvents(
  userId: string,
  since: Date,
) {
  const inWindow = { deletedAt: null, occurredAt: { gte: since } };
  // Two reads: every active definition with its count and newest occurrence
  // in the window, to choose the channels; then the occurrences of the chosen
  // ones only, so an account with many active symptoms reads no more rows
  // than one at the channel bound.
  const candidates = await prisma.symptomDefinition.findMany({
    where: { userId, isActive: true },
    select: {
      id: true,
      createdAt: true,
      _count: { select: { events: { where: inWindow } } },
      events: {
        where: inWindow,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { occurredAt: true },
      },
    },
  });
  const picked = pickCorrelationSymptoms(
    candidates.map((candidate) => ({
      id: candidate.id,
      createdAt: candidate.createdAt,
      eventCount: candidate._count.events,
      lastOccurredAt: candidate.events[0]?.occurredAt ?? null,
    })),
  );
  if (picked.length === 0) return [];
  const rows = await prisma.symptomDefinition.findMany({
    where: { userId, id: { in: picked.map((p) => p.id) } },
    select: {
      id: true,
      labelEncrypted: true,
      events: {
        where: inWindow,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 5000,
        select: { occurredAt: true, intensity: true },
      },
    },
  });
  const rowById = new Map(rows.map((row) => [row.id, row]));
  return picked.flatMap((p) => {
    const row = rowById.get(p.id);
    return row ? [row] : [];
  });
}
