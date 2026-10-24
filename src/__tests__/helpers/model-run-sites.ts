/**
 * Each file that imports a background model-run entry point, and the queues
 * whose jobs reach it. Shared by the guards that hold those queues to their
 * expiry (`ai-job-expiry-guard.test.ts`) and to bounded, backed-off retries
 * (`ai-job-retry-bound-guard.test.ts`); the first proves the table complete.
 */
export const MODEL_RUN_SITES: Readonly<Record<string, readonly string[]>> = {
  "lib/insights/status-card-generation.ts": [
    "insight-status-generate",
    "insights-general-status",
    "insight-pregenerate",
  ],
  "lib/insights/derived/derived-assessment-ai.ts": ["insight-status-generate"],
  "lib/insights/status-batch.ts": [
    "insights-general-status",
    "insight-pregenerate",
  ],
  "lib/insights/narrative/period-narrative-generate.ts": [
    "period-narrative-warm",
  ],
  "lib/ai/coach/conversation-summary.ts": ["coach-memory-refresh"],
  "lib/ai/coach/facts.ts": ["coach-memory-refresh"],
  "lib/ai/coach/plans.ts": ["coach-memory-refresh"],
  "lib/jobs/workout-insight-generate.ts": ["workout-insight-generate"],
  "lib/jobs/insight-pregenerate.ts": ["insight-pregenerate"],
  "lib/jobs/morning-digest-refresh.ts": ["morning-digest-refresh"],
  "lib/documents/extract.ts": ["document-ai-run", "document-index"],
  "lib/documents/index-document.ts": ["document-index", "document-ai-run"],
  "lib/documents/ai-runs/index-run.ts": ["document-ai-run"],
  "lib/documents/ai-runs/summary-run.ts": ["document-ai-run"],
  "lib/documents/ai-runs/suggest-run.ts": ["document-ai-run"],
  "lib/labs/ocr-extract.ts": ["document-ai-run"],
  "lib/jobs/document-ai-run.ts": ["document-ai-run"],
  "lib/jobs/document-content-index-backfill.ts": [
    "document-content-index-backfill",
  ],
  "lib/jobs/document-summary.ts": ["document-summary"],
};
