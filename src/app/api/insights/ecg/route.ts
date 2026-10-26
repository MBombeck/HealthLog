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
 * body or query field). No AI gate and no module gate: a recording is device
 * data, and the `insights` module is the AI analysis opt-out. An ingest is
 * never refused because AI is off; the POST keeps its own rate limit.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { persistEcgRecording } from "@/lib/ecg/persist-recording";
import { isoDateTime } from "@/lib/validations/datetime";
import { apiListSuccess } from "@/lib/api/list-cap";
import { listPage } from "@/lib/http/list-query";

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

// One recording per request, so the limit is per recording. The iPhone app
// sends every recording its sweep has not yet consumed in one go and, on a
// 429, stops and starts the same sweep again on its next wake. A window that
// held more than the limit could therefore never finish: with 60 per minute
// the 61st recording was refused on every sync and the newest ECG never
// arrived (#1060). 600 covers more than a decade of weekly strips in one
// sweep and still stops a leaked token from saturating the write path; a
// request is at most 2 MB and usually about 100 KB.
const INGEST_RATE_LIMIT_MAX = 600;
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
    recordedAt: isoDateTime(),
    // HealthKit hands both of these over as doubles. A watch reports its
    // average heart rate with a fraction (64.7) often enough that requiring
    // an integer refused most new recordings while the old ones, synced when
    // the value happened to be whole, went through (#1060). The columns are
    // integers and the person reads whole beats per minute, so the server
    // rounds once here rather than every client doing it.
    samplingFrequency: z
      .number()
      .min(1)
      .max(10_000)
      .transform((v) => Math.round(v)),
    samples: z
      .array(z.number().int().min(-1_000_000).max(1_000_000))
      .min(1)
      .max(MAX_SAMPLES),
    lead: z.string().min(1).max(40).nullable().optional(),
    averageHeartRate: z
      .number()
      .min(1)
      .max(300)
      .transform((v) => Math.round(v))
      .nullable()
      .optional(),
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

  const { rows, cap } = await listPage(MAX_RECORDINGS, (take) =>
    prisma.ecgRecording.findMany({
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
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      take,
    }),
  );

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
    meta: { count: recordings.length, truncated: cap.truncated },
  });

  return apiListSuccess(
    {
      recordings,
      hasRecordings: recordings.length > 0,
    },
    cap,
  );
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
  // Metered by this route's own bulk bucket below, not the shared per-account
  // write bucket: the native client syncs through here in bursts (see
  // `meterAccountWrite`).
  const { user } = await requireAuth(undefined, { writeBucket: "own" });
  // A device ingest carries no model text: switching AI off, or the AI
  // analysis opt-out, must never refuse a recording.

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

  const parsed = await parseJsonBody(request, ecgIngestSchema, {
    maxBytes: MAX_BODY_BYTES,
    onInvalid: (error) => {
      // Which field was refused and why, never the value: without it a refused
      // recording is a bare "invalid" in the log and the cause has to be guessed.
      annotate({
        action: { name: "insights.ecg.ingest" },
        meta: {
          outcome: "invalid",
          invalidFields: error.issues
            .map((issue) => `${issue.path.join(".") || "(body)"}:${issue.code}`)
            .slice(0, 8)
            .join(","),
        },
      });
    },
  });
  if (!parsed.ok) return parsed.error;

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
