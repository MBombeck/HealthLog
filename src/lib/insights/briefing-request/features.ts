/**
 * The feature set an on-demand briefing is written from: the bounded read,
 * its downgrade ladder for an oversized payload, the user's exclusions, the
 * reader's units, and the compact wire form.
 */
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import { applyInsightsExcludeFilter } from "@/lib/insights/exclude-filter";
import { getCachedFeatures } from "@/lib/insights/feature-cache";
import {
  BRIEFING_FEATURE_WINDOW_DAYS,
  extractFeatures,
  FeaturesPayloadTooLargeError,
} from "@/lib/insights/features";
import { featuresInReaderUnits } from "@/lib/insights/features-units";
import { annotate } from "@/lib/logging/context";
import { resolveUnitPreferences } from "@/lib/measurements/display-transform";

import type { GenerationContext } from "./context";

export type BriefingFeatures = Awaited<ReturnType<typeof extractFeatures>>;

/**
 * The blocks dropped when even the aggregated shape crosses the ceiling
 * (very large medication history + multi-year context), before one last try.
 */
const MAX_DOWNGRADE_TOKENS: ReadonlyArray<string> = [
  "anthropometrics",
  "medications",
  "compliance",
  "sleep",
  "steps",
  "hrv",
  "resting_hr",
];

interface Downgrade {
  payloadDowngraded: boolean;
  payloadHardDowngraded: boolean;
  payloadOversizeBytes: number | null;
}

/**
 * The bounded feature read, computed once per request through the scope the
 * route opened. `extractFeatures` enforces a 5 MB ceiling on the serialised
 * payload and throws `FeaturesPayloadTooLargeError` past it; the raw
 * (bucketed) shape downgrades to the aggregated one rather than 500-ing, so
 * the user still gets an insight, and the annotation surfaces the
 * regression to ops. Null when every rung is still too large.
 */
async function readWithDowngrade(
  userId: string,
  includeRaw: boolean,
  downgrade: Downgrade,
): Promise<BriefingFeatures | null> {
  // The bulk read is bounded to a recent window (all-time extremes are
  // sourced separately, see features.ts); the ladder is the safety net for
  // the rare oversize payload.
  const featureWindow = { sinceDays: BRIEFING_FEATURE_WINDOW_DAYS };
  const read = (raw: boolean) =>
    getCachedFeatures({
      userId,
      includeRaw: raw,
      sinceDays: featureWindow.sinceDays,
      compute: () => extractFeatures(userId, raw, featureWindow),
    });
  try {
    return await read(includeRaw);
  } catch (err) {
    if (!(err instanceof FeaturesPayloadTooLargeError)) throw err;
    downgrade.payloadDowngraded = true;
    downgrade.payloadOversizeBytes = err.sizeBytes;
  }
  try {
    return await read(false);
  } catch (retryErr) {
    if (!(retryErr instanceof FeaturesPayloadTooLargeError)) throw retryErr;
    // The aggregated shape ALSO crossed the ceiling. Drop the optional
    // context blocks via the exclude filter and try once more.
    downgrade.payloadHardDowngraded = true;
    downgrade.payloadOversizeBytes = retryErr.sizeBytes;
  }
  try {
    return applyInsightsExcludeFilter(await read(false), MAX_DOWNGRADE_TOKENS);
  } catch (finalErr) {
    // Even the last read blew up. Annotate and refuse rather than let the
    // uncaught throw 500 out.
    annotate({
      meta: {
        insights_payload_too_large: true,
        insights_payload_oversize_bytes:
          finalErr instanceof FeaturesPayloadTooLargeError
            ? finalErr.sizeBytes
            : downgrade.payloadOversizeBytes,
      },
    });
    return null;
  }
}

export interface PreparedFeatures {
  features: BriefingFeatures;
  compactFeatures: Record<string, unknown>;
  featuresJson: string;
  units: ReturnType<typeof resolveUnitPreferences>;
}

export async function prepareBriefingFeatures(
  ctx: GenerationContext,
): Promise<PreparedFeatures | null> {
  const { dbUser, userId } = ctx;
  const includeRaw = dbUser?.insightsPrivacyMode === "raw";
  const downgrade: Downgrade = {
    payloadDowngraded: false,
    payloadHardDowngraded: false,
    payloadOversizeBytes: null,
  };
  let features = await readWithDowngrade(userId, includeRaw, downgrade);
  if (features === null) return null;
  // The user's exclude-metrics opt-out list, applied BEFORE serialisation so
  // the model never sees the dropped blocks.
  const excludeList = dbUser?.insightsExcludeMetrics ?? [];
  features = applyInsightsExcludeFilter(features, excludeList);
  // The reader's units, after all canonical arithmetic: the prompt, the
  // stored hash and the grounding check read the same converted figures.
  const units = resolveUnitPreferences({
    unitPreference: dbUser?.unitPreference,
    glucoseUnit: dbUser?.glucoseUnit,
  });
  features = featuresInReaderUnits(features, units);
  // Zero-row blocks are dropped so the prompt never carries labelled-empty
  // sections (`"sleep": []`, `"medications": []`, etc.), which made the
  // model narrate "there are no medications in your data" when the user
  // explicitly excluded the block.
  const compactFeatures = compactSections(
    features as unknown as Record<string, unknown>,
  );
  // Compact on the wire: indentation is about 40% of a pretty-printed
  // payload, and the model reads the structure without it (#1217).
  const featuresJson = JSON.stringify(compactFeatures);
  if (downgrade.payloadDowngraded) {
    annotate({
      meta: {
        insights_features_downgraded: true,
        insights_features_oversize_bytes: downgrade.payloadOversizeBytes,
        insights_features_hard_downgraded: downgrade.payloadHardDowngraded,
      },
    });
  }
  return { features, compactFeatures, featuresJson, units };
}
