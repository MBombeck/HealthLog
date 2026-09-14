/**
 * v1.28.50 — single ECG recording WITH waveform.
 *
 * `GET /api/insights/ecg/[id]` returns one recording's decrypted waveform
 * plus its metadata and the DEVICE's own rhythm classification. Ownership
 * is narrowed IN THE `where` (`{ id, userId }`) so a cross-user read is
 * structurally impossible — a foreign or unknown id resolves to null and
 * 404s, sealing existence exactly like the documents cache-leak fix.
 *
 * The waveform is AES-256-GCM at rest; it is decrypted through the
 * existing fail-closed `decryptWaveformFromBytes` (a bad key id or a
 * non-array payload throws rather than leaking plaintext). By default the
 * ~9000-sample strip is min/max-decimated to ~2500 display points so the
 * R-wave peaks survive the reduction (see `decimateMinMax`); `?full=1`
 * returns the raw array for the true-calibration zoom view.
 *
 * Regulatory framing (load-bearing): the response carries the waveform,
 * the metadata, and the device's verbatim `classification` ONLY. HealthLog
 * does not interpret the trace, measure intervals, annotate beats, or emit
 * a verdict of its own.
 *
 * Mirrors the `rhythm-events` gating: `apiHandler`, cookie OR Bearer auth,
 * `userId` from the session, the `insights` module gate, and the
 * `insightStatus` assistant-surface gate. No AI provider call.
 */
import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { decryptWaveformFromBytes } from "@/lib/withings/ecg-waveform-codec";
import {
  ECG_DISPLAY_TARGET_POINTS,
  decimateMinMax,
} from "@/lib/insights/ecg-decimate";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE-level read: computed over the whole record, with no
    // provider anywhere on the path.
    const { user } = await requireRecordAuth("manage", "record");
    const m = await requireModuleEnabled(user.id, "insights");
    if (!m.enabled) return m.response;
    // The waveform is never interpreted, so no assistant-surface gate.

    const { id } = await params;
    const full = request.nextUrl.searchParams.get("full") === "1";

    // Ownership narrowed in the where — a foreign / unknown id is null.
    const row = await prisma.ecgRecording.findFirst({
      where: { id, userId: user.id },
      select: {
        recordedAt: true,
        durationSeconds: true,
        samplingFrequency: true,
        averageHeartRate: true,
        lead: true,
        rhythmClassification: true,
        source: true,
        waveformEncrypted: true,
      },
    });

    if (!row) {
      return apiError("ECG recording not found", 404);
    }

    // Fail-closed decrypt (throws on a bad key id / non-array payload).
    const raw = decryptWaveformFromBytes(row.waveformEncrypted);

    const decimated = !full && raw.length > ECG_DISPLAY_TARGET_POINTS;
    const samples = decimated
      ? decimateMinMax(raw, ECG_DISPLAY_TARGET_POINTS)
      : raw;

    annotate({
      action: { name: "insights.ecg.detail" },
      meta: { sampleCount: raw.length, decimated },
    });

    const res = apiSuccess({
      recordedAt: row.recordedAt.toISOString(),
      durationSeconds: row.durationSeconds,
      samplingFrequency: row.samplingFrequency,
      averageHeartRate: row.averageHeartRate,
      lead: row.lead,
      classification: row.rhythmClassification,
      source: row.source,
      samples,
      decimated,
    });
    // Never cache a decrypted health-data waveform at any hop.
    res.headers.set("Cache-Control", "no-store");
    return res;
  },
);
