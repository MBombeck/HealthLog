/**
 * Lab results from Apple Health's Health Records, out of an `export.zip`
 * (#1400).
 *
 * `export.xml` lists each Health Records resource as a `<ClinicalRecord>`
 * whose `resourceFilePath` names a FHIR JSON file under `clinical-records/`.
 * The XML pass hands the lab-result references here
 * (`routeClinicalRecord`); this module then reads the referenced members one
 * at a time, maps each with the shared FHIR mapper, gives members their
 * panel's name, and writes through the shared writer, so a result lands the
 * same way it would from the iOS app (`POST /api/labs/fhir-batch`).
 *
 * A reference with no path (an export from a Health app that did not write
 * one) is matched by the resource's own id among the clinical files instead.
 *
 * Memory: one member is held at a time, capped by the archive reader; what is
 * kept across members is the mapped readings (a few hundred bytes each) and
 * the panel headers' member lists.
 *
 * A failure here never fails the import: the measurements are committed. A
 * missing, oversized or malformed file is counted as failed. Nothing about a
 * resource reaches the result, the logs or a wide event: only counts and
 * closed reasons.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  APPLE_HEALTH_ARCHIVE_MAX_ENTRIES,
  clinicalMemberNameFromReference,
  isClinicalRecordJson,
  streamAppleHealthClinicalMembers,
  type AppleHealthClinicalArchiveLimits,
} from "@/lib/apple-health/archive-stream";
import type { ClinicalLabReference } from "@/lib/apple-health/clinical-record-ref";
import { afterLabReadingsWritten } from "@/lib/labs/fhir-import/after-write";
import {
  assignPanels,
  mapFhirLabRecord,
  type FhirLabMapping,
} from "@/lib/labs/fhir-import/map-observation";
import {
  emptyFhirLabCounts,
  type FhirLabCounts,
  type FhirLabImportReason,
} from "@/lib/labs/fhir-import/types";
import { writeFhirLabReadings } from "@/lib/labs/fhir-import/write";
import { jsonDeeperThan } from "@/lib/import/json-depth";
import { annotate } from "@/lib/logging/context";
import type { ImportJobResult } from "@/lib/measurements/import-apple-health-export";

/** The terminal result of an Apple Health import job, labs included. */
export type AppleHealthImportJobResult = ImportJobResult & {
  labs: FhirLabCounts;
};

/** Per-archive ceilings for the Health Records members. */
export const APPLE_HEALTH_CLINICAL_ARCHIVE_LIMITS: AppleHealthClinicalArchiveLimits =
  {
    maxMembers: APPLE_HEALTH_ARCHIVE_MAX_ENTRIES,
    maxClinicalMembers: 50_000,
    // A single Observation is a few KB; 2 MiB leaves room for a long note.
    maxMemberBytes: 2 * 1024 * 1024,
    maxTotalClinicalBytes: 256 * 1024 * 1024,
    maxCompressionRatio: 200,
  };

async function readJson(stream: AsyncIterable<unknown>): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  for (const chunk of chunks) chunk.fill(0);
  const parsed = JSON.parse(text) as unknown;
  // Refused like malformed JSON: the mapper and the writer walk the resource.
  if (jsonDeeperThan(parsed)) throw new Error("nested too deeply");
  return parsed;
}

function resourceId(resource: unknown): string | null {
  if (typeof resource !== "object" || resource === null) return null;
  const id = (resource as { id?: unknown }).id;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

export async function importAppleHealthClinicalLabs(input: {
  archivePath: string;
  userId: string;
  tz: string;
  references: readonly ClinicalLabReference[];
  /** References the job counted past its cap and did not keep. */
  overflow?: number;
  prisma?: Pick<
    PrismaClient,
    "labResult" | "biomarker" | "biomarkerAlias" | "labResultImportKey"
  >;
  limits?: AppleHealthClinicalArchiveLimits;
}): Promise<FhirLabCounts> {
  const counts = emptyFhirLabCounts();
  const limits = input.limits ?? APPLE_HEALTH_CLINICAL_ARCHIVE_LIMITS;
  const dropped = input.overflow ?? 0;
  counts.discovered = input.references.length + dropped;
  if (counts.discovered === 0) return counts;

  // The job result keeps this tally (#1421); the status route serves it.
  const tally = counts.reasons;
  const note = (reason: FhirLabImportReason, by = 1) => {
    tally[reason] = (tally[reason] ?? 0) + by;
  };

  // More references than the archive may hold clinical files: the overflow
  // is refused, the rest is read. The job stops keeping references at the
  // same ceiling and hands over how many it only counted.
  const usable = input.references.slice(0, limits.maxClinicalMembers);
  const overflow = input.references.length - usable.length + dropped;
  counts.failed += overflow;
  if (overflow > 0) note("over_limit", overflow);

  const byMember = new Map<string, ClinicalLabReference>();
  const byId = new Map<string, ClinicalLabReference>();
  for (const ref of usable) {
    const member = ref.path ? clinicalMemberNameFromReference(ref.path) : null;
    if (member && !byMember.has(member)) byMember.set(member, ref);
    else if (!ref.path && ref.identifier && !byId.has(ref.identifier)) {
      byId.set(ref.identifier, ref);
    } else {
      // An unsafe path, or a second reference to one file.
      counts.failed += 1;
      note("bad_reference");
    }
  }
  const expected = byMember.size + byId.size;
  let handled = 0;

  const mapped: FhirLabMapping[] = [];
  try {
    for await (const member of streamAppleHealthClinicalMembers({
      archivePath: input.archivePath,
      limits,
      wanted: (name) =>
        byMember.has(name) || (byId.size > 0 && isClinicalRecordJson(name)),
    })) {
      const byPath = byMember.get(member.name);
      if (member.refused) {
        // Over a per-member limit: this file fails, the rest are read.
        if (byPath) {
          handled += 1;
          counts.failed += 1;
          note(`member_${member.refused}` as const);
        }
        continue;
      }
      let resource: unknown;
      try {
        resource = await readJson(member.stream);
      } catch {
        if (byPath) {
          handled += 1;
          counts.failed += 1;
          note("malformed_json");
        }
        continue;
      }
      let ref = byPath;
      if (!ref) {
        const id = resourceId(resource);
        ref = id ? byId.get(id) : undefined;
        if (!ref || !id) continue;
        byId.delete(id);
      }
      handled += 1;
      const result = mapFhirLabRecord({
        resource,
        fhirVersion: ref.fhirVersion,
        identifier: ref.identifier,
        sourceURL: ref.sourceURL,
        sourceName: ref.sourceName,
        requireLabCategory: !ref.labTyped,
      });
      resource = null;
      if (result.kind === "reading") {
        mapped.push(result);
      } else if (result.kind === "skip") {
        counts.skipped += 1;
        note(result.reason);
        if (result.reason === "panel_header") mapped.push(result);
      } else {
        counts.failed += 1;
        note(result.reason);
      }
    }
  } catch {
    // The archive itself is unreadable for this pass (a limit hit in the
    // directory, an inflate failure): the files not yet read are counted
    // below as missing. What was read is still written.
    note("archive_unreadable");
  }
  const missing = Math.max(0, expected - handled);
  counts.failed += missing;
  if (missing > 0) note("missing_member", missing);

  assignPanels(mapped);
  const readings = mapped.flatMap((m) =>
    m.kind === "reading" ? [m.reading] : [],
  );
  mapped.length = 0;
  if (readings.length > 0) {
    try {
      const written = await writeFhirLabReadings({
        userId: input.userId,
        tz: input.tz,
        readings,
        prisma: input.prisma,
      });
      counts.imported += written.inserted;
      counts.duplicate += written.duplicate;
      counts.failed += written.failed;
      counts.markersCreated += written.markersCreated;
      for (const status of written.statuses) {
        if (status.status === "failed") note(status.reason);
      }
      afterLabReadingsWritten({
        userId: input.userId,
        inserted: written.inserted,
        newestTakenAt: written.newestTakenAt,
        source: "apple_health_export",
      });
    } catch {
      counts.failed += readings.length;
      note("write_failed");
    }
  }

  annotate({
    action: { name: "apple_health.import.clinical_labs" },
    meta: {
      discovered: counts.discovered,
      imported: counts.imported,
      duplicate: counts.duplicate,
      skipped: counts.skipped,
      failed: counts.failed,
      markers_created: counts.markersCreated,
      reasons: tally,
    },
  });
  return counts;
}
