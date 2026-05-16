import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";

/**
 * v1.4.31 — Assistant-surface operator feature flags.
 *
 * Six boolean toggles on `AppSettings` carve the visibility cut for
 * the seven LLM-driven surfaces. The master flag is a single kill-
 * switch; the five sub-flags carve specific surfaces.
 *
 * `assistant.enabled = false` forces every sub-flag false in the
 * resolved shape — the master always wins. This means a server-side
 * caller never has to compose `master && sub`; reading
 * `flags.coach` already accounts for both layers.
 *
 * Per `.planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md` §3 R5: the
 * matrix gates BOTH server-routed AND iOS on-device assistant
 * surfaces. The `GET /api/feature-flags` endpoint projects this
 * shape so iOS reads the same authoritative set the web reads.
 */

/** The five assistant sub-flags the operator can carve. */
export type AssistantSurface =
  | "coach"
  | "briefing"
  | "insightStatus"
  | "correlations"
  | "healthScoreExplainer";

export interface AssistantFlagSet {
  /** Master kill-switch — when false, every sub-flag is forced false. */
  enabled: boolean;
  /** Coach drawer, chat SSE, history rail, feedback. */
  coach: boolean;
  /** Daily Briefing card + advisor recommendations + regen icon. */
  briefing: boolean;
  /** Per-metric status cards on every `/insights/<metric>` sub-page. */
  insightStatus: boolean;
  /** Correlation narration tile on the mother page. */
  correlations: boolean;
  /** `?` glyph that opens the Health-Score delta explainer popover. */
  healthScoreExplainer: boolean;
}

/** All-on default; mirrors v1.4.30 behaviour for fresh installs. */
export const ASSISTANT_FLAGS_DEFAULT: AssistantFlagSet = Object.freeze({
  enabled: true,
  coach: true,
  briefing: true,
  insightStatus: true,
  correlations: true,
  healthScoreExplainer: true,
});

/**
 * Load the assistant flag set from `AppSettings`. Read-through pattern
 * matches `getGlobalServiceAvailability()` — null/error/missing-row all
 * fall back to defaults so the assistant stays visible on first boot.
 *
 * The master always wins: every sub-flag is forced false when the
 * master is off, before the resolved set leaves this function.
 */
export async function getAssistantFlags(): Promise<AssistantFlagSet> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        assistantEnabled: true,
        assistantCoachEnabled: true,
        assistantBriefingEnabled: true,
        assistantInsightStatusEnabled: true,
        assistantCorrelationsEnabled: true,
        assistantHealthScoreExplainerEnabled: true,
      },
    });

    const master = settings?.assistantEnabled ?? true;
    return resolveAssistantFlags({
      enabled: master,
      coach: settings?.assistantCoachEnabled ?? true,
      briefing: settings?.assistantBriefingEnabled ?? true,
      insightStatus: settings?.assistantInsightStatusEnabled ?? true,
      correlations: settings?.assistantCorrelationsEnabled ?? true,
      healthScoreExplainer:
        settings?.assistantHealthScoreExplainerEnabled ?? true,
    });
  } catch {
    getEvent()?.addWarning(
      "Failed to load assistant feature flags, using defaults",
    );
    return ASSISTANT_FLAGS_DEFAULT;
  }
}

/**
 * Pure resolver — given a raw set of master + sub-flag values, return
 * the operator-effective shape. Exposed for unit tests and for the
 * admin PUT handler that needs to echo the resolved set after a write.
 */
export function resolveAssistantFlags(raw: AssistantFlagSet): AssistantFlagSet {
  if (!raw.enabled) {
    return {
      enabled: false,
      coach: false,
      briefing: false,
      insightStatus: false,
      correlations: false,
      healthScoreExplainer: false,
    };
  }
  return { ...raw };
}

/**
 * Error class thrown by `requireAssistantSurface()` when the operator
 * has disabled the surface. The api-handler catches it and returns
 * the 403 envelope per the iOS contract (R5):
 *
 *   { data: null, error: "...", meta: { errorCode: "assistant.disabled.<surface>" } }
 *
 * Older iOS clients that predate the v1.4.31 contract surface this as
 * a generic 403 (their existing 403-handler covers the case); v1.4.31+
 * clients read the `errorCode` to render the `AssistantDisabledNotice`
 * empty-state.
 */
export class AssistantDisabledError extends Error {
  readonly surface: AssistantSurface;
  readonly errorCode: string;

  constructor(surface: AssistantSurface) {
    super(`Assistant surface "${surface}" is disabled on this server`);
    this.name = "AssistantDisabledError";
    this.surface = surface;
    this.errorCode = `assistant.disabled.${surface}`;
  }
}

/**
 * Server-side gate helper. Throws `AssistantDisabledError` when the
 * relevant surface (or the master) is off. Routes call this near the
 * top, after auth and rate-limit, and let the apiHandler catch turn
 * it into the 403 envelope.
 */
export async function requireAssistantSurface(
  surface: AssistantSurface,
): Promise<AssistantFlagSet> {
  const flags = await getAssistantFlags();
  if (!flags[surface]) {
    throw new AssistantDisabledError(surface);
  }
  return flags;
}
