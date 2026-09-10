/**
 * v1.39 (C1) — does a record already hold data in a module's domain?
 *
 * The setup flow's derivation writes an explicit `false` for every module the
 * answers did not name, and that is the right answer for a record that is
 * being set up. It is the wrong answer for a record that already has years of
 * rows: an established self-hoster upgrading into the flow has, for most
 * modules, no stored preference at all — they were default-on and nobody ever
 * touched the toggle — so the first confirm would switch off the nav entry,
 * the dashboard widget and the settings entry for domains that hold content.
 * The rows would survive; the surfaces would not. The design spec's second
 * principle is that nothing is lost by a choice, and it says that about a NEW
 * record; it says nothing about one with content, so the derivation asks here
 * before it retracts anything.
 *
 * The ownership question is not re-answered here. The measurement-level
 * domains come from {@link measurementTypesOwnedBy}, which is the same map the
 * MCP reads and the Coach snapshot gate off, so a type that changes hands
 * cannot drift out of sync with this. What this file adds is the per-module
 * table each domain's non-measurement content lives in, one named entry per
 * module, exhaustive over `OwnedModuleKey` so a module added next year fails
 * to compile until somebody names where its content lives.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { measurementTypesOwnedBy } from "./measurement-scope";
import type { OwnedModuleKey } from "./registry";

/** The delegates this file reads. Narrow so a worker's client fits too. */
type DomainDataClient = Pick<
  PrismaClient,
  | "measurement"
  | "moodEntry"
  | "workout"
  | "labResult"
  | "illnessEpisode"
  | "userAchievement"
  | "insightNarrative"
  | "medication"
  | "encounter"
  | "environmentContext"
  | "mcpOAuthConnection"
  | "inboundDocument"
  | "mentalHealthAssessment"
  | "nutrientIntakeDay"
  | "vaccinationRecord"
>;

type DomainProbe = (
  client: DomainDataClient,
  recordId: string,
) => Promise<boolean>;

/** One indexed existence read; a soft-deleted row is not content. */
async function anyRow(find: PromiseLike<unknown>): Promise<boolean> {
  return (await find) !== null;
}

/** Does the record hold any measurement in the types this module owns? */
function measurementProbe(key: OwnedModuleKey): DomainProbe {
  const types = measurementTypesOwnedBy(key);
  return async (client, recordId) => {
    if (types.length === 0) return false;
    return anyRow(
      client.measurement.findFirst({
        where: { userId: recordId, deletedAt: null, type: { in: types } },
        select: { id: true },
      }),
    );
  };
}

/** Either the module's own table or the measurements it owns. */
function eitherProbe(a: DomainProbe, b: DomainProbe): DomainProbe {
  return async (client, recordId) =>
    (await a(client, recordId)) || (await b(client, recordId));
}

/**
 * Where each module's content lives.
 *
 * Exhaustive by type. Every entry names one table (or one measurement domain)
 * whose rows mean "this record uses this module", and nothing here reads a
 * preference, a connection state or a cache — the question is content, not
 * configuration.
 */
const MODULE_DOMAIN_PROBES: Record<OwnedModuleKey, DomainProbe> = {
  mood: eitherProbe(
    (client, recordId) =>
      anyRow(
        client.moodEntry.findFirst({
          where: { userId: recordId, deletedAt: null },
          select: { id: true },
        }),
      ),
    measurementProbe("mood"),
  ),
  sleep: measurementProbe("sleep"),
  glucose: measurementProbe("glucose"),
  workouts: eitherProbe(
    (client, recordId) =>
      anyRow(
        client.workout.findFirst({
          where: { userId: recordId },
          select: { id: true },
        }),
      ),
    measurementProbe("workouts"),
  ),
  recovery: measurementProbe("recovery"),
  labs: (client, recordId) =>
    anyRow(
      client.labResult.findFirst({
        where: { userId: recordId, deletedAt: null },
        select: { id: true },
      }),
    ),
  illness: (client, recordId) =>
    anyRow(
      client.illnessEpisode.findFirst({
        where: { userId: recordId, deletedAt: null },
        select: { id: true },
      }),
    ),
  achievements: (client, recordId) =>
    anyRow(
      client.userAchievement.findFirst({
        where: { userId: recordId },
        select: { id: true },
      }),
    ),
  insights: (client, recordId) =>
    anyRow(
      client.insightNarrative.findFirst({
        where: { userId: recordId },
        select: { id: true },
      }),
    ),
  medications: (client, recordId) =>
    anyRow(
      client.medication.findFirst({
        where: { userId: recordId },
        select: { id: true },
      }),
    ),
  // The doctor report is built from the visits, so a recorded encounter is
  // what "this record uses the report surface" looks like in the data.
  doctorReport: (client, recordId) =>
    anyRow(
      client.encounter.findFirst({
        where: { userId: recordId, deletedAt: null },
        select: { id: true },
      }),
    ),
  environment: eitherProbe(
    (client, recordId) =>
      anyRow(
        client.environmentContext.findFirst({
          where: { userId: recordId },
          select: { id: true },
        }),
      ),
    measurementProbe("environment"),
  ),
  // The endpoint holds no content of its own; a live authorisation is the
  // nearest thing, and switching it off under a connected assistant would
  // break a wire somebody set up on purpose.
  mcp: (client, recordId) =>
    anyRow(
      client.mcpOAuthConnection.findFirst({
        where: { userId: recordId },
        select: { id: true },
      }),
    ),
  inboundDocuments: (client, recordId) =>
    anyRow(
      client.inboundDocument.findFirst({
        where: { userId: recordId, deletedAt: null },
        select: { id: true },
      }),
    ),
  mentalHealth: (client, recordId) =>
    anyRow(
      client.mentalHealthAssessment.findFirst({
        where: { userId: recordId, deletedAt: null },
        select: { id: true },
      }),
    ),
  nutrients: (client, recordId) =>
    anyRow(
      client.nutrientIntakeDay.findFirst({
        where: { userId: recordId },
        // Keyed on the day and the nutrient, not on an id of its own.
        select: { userId: true },
      }),
    ),
  vaccinations: (client, recordId) =>
    anyRow(
      client.vaccinationRecord.findFirst({
        where: { userId: recordId, deletedAt: null },
        select: { id: true },
      }),
    ),
};

/**
 * Which of `candidates` already hold data for this record.
 *
 * Only the candidates are read, because the caller only ever asks about the
 * modules it is about to switch off — a confirm that names everything reads
 * nothing. Each probe is one indexed existence read.
 */
export async function modulesHoldingRecordData(
  client: DomainDataClient,
  recordId: string,
  candidates: readonly OwnedModuleKey[],
): Promise<Set<OwnedModuleKey>> {
  const holding = new Set<OwnedModuleKey>();
  await Promise.all(
    candidates.map(async (key) => {
      if (await MODULE_DOMAIN_PROBES[key](client, recordId)) holding.add(key);
    }),
  );
  return holding;
}
