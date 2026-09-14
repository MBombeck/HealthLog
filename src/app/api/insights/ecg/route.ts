/**
 * ECG recording list route (metadata only, no waveform) + the live ingest.
 *
 * `GET /api/insights/ecg` returns the authenticated user's ECG recordings
 * as a cheap, index-covered metadata list — recorded time, duration,
 * sampling rate, sample count, average heart rate, lead, and the DEVICE's
 * own rhythm classification. It NEVER decrypts or returns the waveform;
 * the per-recording strip is fetched on demand via
 * `GET /api/insights/ecg/[id]`.
 *
 * Regulatory framing (load-bearing): this surface reflects ONLY the
 * classification RESULT the recording device's certified on-device
 * algorithm produced. HealthLog never re-classifies an ECG, never reads
 * the waveform to form a verdict, and never produces a diagnosis. The
 * `classification` field the client renders is the device's, verbatim.
 *
 * Data-availability-gated by construction: an account with no recordings
 * gets `{ recordings: [], hasRecordings: false }`, and the client un-mounts
 * the whole surface rather than painting an empty card.
 *
 * `POST /api/insights/ecg` is the live ingest: one Apple Watch recording per
 * request, sent by the native client's HealthKit reader as it observes new
 * strips. Before it existed, a watch ECG could only reach HealthLog inside a
 * full `export.zip`. It stores what the device reported and derives nothing
 * clinical: `sampleCount` and `durationSeconds` come from the payload, the
 * classification is the device's own verdict copied verbatim, and the
 * waveform is never read to form an opinion.
 *
 * Both verbs mirror the `rhythm-events` route gating exactly: `apiHandler`
 * wrapper, cookie OR Bearer auth, `userId` narrowed from the session (never a
 * body or query field), the `insights` module gate, and the `insightStatus`
 * assistant-surface gate. No AI provider call on either path.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { persistEcgRecording } from "@/lib/ecg/persist-recording";

export const dynamic = "force-dynamic";

// Defensive cap. A ScanWatch user records a handful to a few dozen strips
// over time; this is a bound, not an expected ceiling.
const MAX_RECORDINGS = 200;

// A 30 s Apple Watch strip at 512 Hz is ~15 360 samples. This leaves a clean
// factor of two above that, which covers a 60 s recording or a 1024 Hz one
// without inviting an unbounded array.
const MAX_SAMPLES = 32_768;

// Backstop for the sample cap. 32 768 integer micro-volt samples serialise to
// roughly 250 KB with separators; 2 MB rejects a hostile payload before
// `JSON.parse` sees it while leaving an order of magnitude of headroom above
// any real recording. A DoS ceiling, not a tight bound.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// One recording per request, so the limit is per recording. A person records
// a handful of strips a week; 60/min still drains a full watch history in
// minutes and stops a leaked wildcard token from saturating the write path.
const INGEST_RATE_LIMIT_MAX = 60;
const INGEST_RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Only the three ECG verdicts. `RhythmClassification` in the database has six
// members because walking-steadiness and neutral event verdicts share the
// enum; those cannot appear on an ECG row and are not accepted here.
const ecgClassificationEnum = z.enum([
  "IRREGULAR",
  "NOT_DETECTED",
  "INCONCLUSIVE",
]);

// A client may only claim the source it actually is. `WITHINGS` rows are
// minted by the OAuth sync and `COMPUTED` ones by the server, so letting an
// authenticated client assert either would let it forge rows an integration
// never produced — the same posture the measurement batch takes.
const ingestSourceEnum = z.enum(["APPLE_HEALTH"]);

// `.strict()` on purpose: every field here is load-bearing, and a silently
// dropped unknown key would mean a recording stored with wrong metadata and
// nobody told. An unknown key gets a 422 that names it.
const ecgIngestSchema = z
  .object({
    externalRecordingId: z.string().min(1).max(120),
    recordedAt: z.iso.datetime({ offset: true }),
    samplingFrequency: z.number().int().min(1).max(10_000),
    samples: z
      .array(z.number().int().min(-1_000_000).max(1_000_000))
      .min(1)
      .max(MAX_SAMPLES),
    lead: z.string().min(1).max(40).nullable().optional(),
    averageHeartRate: z.number().int().min(1).max(300).nullable().optional(),
    classification: ecgClassificationEnum.nullable().optional(),
    source: ingestSourceEnum,
  })
  .strict();

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: the record's own recordings, listed without
  // touching the encrypted waveform. The POST below is a device ingest and
  // keeps `requireAuth()`: a delegate's phone must never move somebody else's
  // sync.
  const { user } = await requireRecordAuth("manage", "record");
  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;
  // A pure read of the device's own recordings, so no assistant-surface
  // gate.

  const rows = await prisma.ecgRecording.findMany({
    where: { userId: user.id },
    // Everything EXCEPT `waveformEncrypted` — the list never touches the
    // encrypted blob, so no decrypt happens on this path.
    select: {
      id: true,
      recordedAt: true,
      durationSeconds: true,
      samplingFrequency: true,
      sampleCount: true,
      averageHeartRate: true,
      lead: true,
      rhythmClassification: true,
      source: true,
    },
    orderBy: { recordedAt: "desc" },
    take: MAX_RECORDINGS,
  });

  const recordings = rows.map((r) => ({
    id: r.id,
    recordedAt: r.recordedAt.toISOString(),
    durationSeconds: r.durationSeconds,
    samplingFrequency: r.samplingFrequency,
    sampleCount: r.sampleCount,
    averageHeartRate: r.averageHeartRate,
    lead: r.lead,
    classification: r.rhythmClassification,
    source: r.source,
    // A `ts-` fallback event carries a verdict but no signal to fetch.
    hasWaveform: r.sampleCount > 0,
  }));

  annotate({
    action: { name: "insights.ecg.list" },
    meta: { count: recordings.length },
  });

  return apiSuccess({
    recordings,
    hasRecordings: recordings.length > 0,
  });
});

/**
 * `POST /api/insights/ecg` — one recording per request.
 *
 * The outcome is reported honestly rather than optimistically, because the
 * client uses it to advance its sync cursor:
 *
 *   - `inserted` — a new recording landed.
 *   - `updated` — this recording id was already stored and the row was
 *     overwritten in place. A re-post is safe and creates nothing.
 *   - `duplicate` — this exact recording is already stored under a different
 *     id, i.e. it already came in through the `export.zip` importer. Nothing
 *     was written; `id` names the row that holds it. A re-sync after an
 *     archive import is harmless, not an error.
 *
 * There is no `Idempotency-Key` on this route and none is needed: the
 * recording carries its own identity, so a retried or replayed POST resolves
 * to the same row by construction rather than by a cached response.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;
  // A device ingest carries no assistant prose, so switching the assistant
  // off must not refuse a recording.

  const rl = await checkRateLimit(
    `insights:ecg:ingest:${user.id}`,
    INGEST_RATE_LIMIT_MAX,
    INGEST_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "insights.ecg.ingest" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many ECG submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson<unknown>(request, {
    maxBytes: MAX_BODY_BYTES,
  });
  if (jsonError) return jsonError;

  const parsed = ecgIngestSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "insights.ecg.ingest" },
      meta: { outcome: "invalid" },
    });
    return returnAllZodIssues(parsed.error);
  }

  const body = parsed.data;
  const result = await persistEcgRecording(
    {
      // Narrowed from the session. The body has no `userId` field and a
      // caller cannot name one.
      userId: user.id,
      source: body.source,
      externalRecordingId: body.externalRecordingId,
      recordedAt: new Date(body.recordedAt),
      samples: body.samples,
      samplingFrequency: body.samplingFrequency,
      lead: body.lead ?? null,
      averageHeartRate: body.averageHeartRate ?? null,
      // The device's own verdict, stored verbatim. Never derived here.
      rhythmClassification: body.classification ?? null,
    },
    prisma,
  );

  annotate({
    action: { name: "insights.ecg.ingest" },
    meta: {
      outcome: result.outcome,
      source: body.source,
      sampleCount: result.sampleCount,
      samplingFrequency: body.samplingFrequency,
    },
  });

  return apiSuccess(
    {
      id: result.id,
      status: result.outcome,
      recordedAt: body.recordedAt,
      sampleCount: result.sampleCount,
      durationSeconds: result.durationSeconds,
    },
    result.outcome === "inserted" ? 201 : 200,
  );
});
