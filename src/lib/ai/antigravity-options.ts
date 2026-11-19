/**
 * ACP model and thought-level configuration options negotiation for Antigravity CLI.
 */
import type { AcpConnection, JsonRpcResponse } from "./antigravity-acp";
import { ANTIGRAVITY_ERRORS, AntigravityError } from "./antigravity-errors";
import type { ReasoningEffort } from "./reasoning-effort";
import {
  capReasoningLevel,
  stricterReasoningLevel,
  type ReasoningLevel,
} from "./reasoning/levels";

export { stricterReasoningLevel };

export const SETUP_TIMEOUT_MS = 30_000;

/** Unwrap a response, or throw with a generic message. The CLI text stays in originalError. */
export function resultOrThrow<T>(
  response: JsonRpcResponse,
  code: string,
  label: string,
): T {
  if (response.error) {
    const authRequired = /authentication required/i.test(
      response.error.message,
    );
    throw new AntigravityError(
      label,
      authRequired ? ANTIGRAVITY_ERRORS.AUTH_REQUIRED : code,
      response.error,
    );
  }
  return response.result as T;
}

/** One model the CLI offers in a profile. */
export interface AntigravityModel {
  id: string;
  name: string;
}

/** The model selector from a session's `configOptions`. */
export interface AntigravityModelOptions {
  /** The `configId` that `session/set_config_option` takes. */
  configId: string;
  models: AntigravityModel[];
  /** The model the CLI uses when none is selected. */
  currentModel: string | null;
}

/** The thought level selector from a session's `configOptions`. */
export interface AntigravityThoughtLevelOptions {
  /** The `configId` that `session/set_config_option` takes. */
  configId: string;
  choices: string[];
  /** The thought level the CLI uses when none is selected. */
  currentLevel: string | null;
}

/**
 * Read the thought_level selector out of a session's `configOptions`.
 * Discovers the option by category or id `thought_level` / `thoughtLevel`
 * with type `select`. Grouped choices are flattened. Null when absent.
 */
export function thoughtLevelOptionsOf(
  configOptions: unknown,
): AntigravityThoughtLevelOptions | null {
  if (!Array.isArray(configOptions)) return null;
  const option = configOptions.find(
    (o): o is Record<string, unknown> =>
      typeof o === "object" &&
      o !== null &&
      ((o as { category?: unknown }).category === "thought_level" ||
        (o as { id?: unknown }).id === "thought_level" ||
        (o as { id?: unknown }).id === "thoughtLevel") &&
      (o as { type?: unknown }).type === "select",
  );
  if (!option || typeof option.id !== "string") return null;
  if (!Array.isArray(option.options)) return null;

  const entries: unknown[] = [];
  for (const entry of option.options as unknown[]) {
    if (typeof entry === "object" && entry !== null && "options" in entry) {
      const group = (entry as { options?: unknown }).options;
      if (Array.isArray(group)) entries.push(...group);
    } else {
      entries.push(entry);
    }
  }

  const choices: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      choices.push(entry.trim());
    } else if (typeof entry === "object" && entry !== null) {
      const val = (entry as { value?: unknown }).value;
      if (typeof val === "string" && val.trim().length > 0) {
        choices.push(val.trim());
      }
    }
  }

  return {
    configId: option.id,
    choices,
    currentLevel:
      typeof option.currentValue === "string" ? option.currentValue : null,
  };
}

/**
 * Maps the taxonomy (off/none/low/medium/high) onto the ACP thought_level.
 * Unsupported "off" or "none" safely maps to "low".
 */
export function mapToAgyThoughtLevel(
  level: string | null | undefined,
): string | null {
  if (!level) return null;
  const lower = level.toLowerCase().trim();
  if (lower === "off" || lower === "none") return "low";
  if (lower === "low" || lower === "medium" || lower === "high") {
    return lower;
  }
  return null;
}

/**
 * Resolves the effective target thought level for an Antigravity call.
 * Precedence:
 * 1. Admin cap / switch "off" -> "low" (lowest supported level, honoring offIsReal: false).
 * 2. Explicit manual call "off" or "none" -> "low".
 * 3. Deliberate background job policy (admin off or frugal level) marked via
 *    maxEffort === "off" -> "low".
 * 4. Explicit manual Coach selection (isExplicit === true) -> overrides saved provider default,
 *    subject to administrative/cost cap (maxEffort).
 * 5. Saved provider effort (this.reasoningEffort) -> provider default (overrides non-explicit/default Coach),
 *    subject to administrative/cost cap (maxEffort).
 * 6. Explicit per-call reasoning effort (when this.reasoningEffort is not set and call has a level),
 *    subject to administrative/cost cap (maxEffort).
 * 7. Unconfigured default -> if maxEffort is "low" or "medium", clamped to maxEffort;
 *    otherwise null (preserves agy CLI's default "high" without sending set_config_option).
 */
export function resolveTargetThoughtLevel(
  paramsReasoningEffort: string | null | undefined,
  savedProviderEffort: ReasoningEffort | null | undefined,
  maxEffort?: ReasoningLevel | null,
  isExplicit?: boolean,
): string | null {
  if (
    paramsReasoningEffort === "off" ||
    paramsReasoningEffort === "none" ||
    maxEffort === "off"
  ) {
    return "low";
  }

  let candidate: string | null = null;
  if (isExplicit && paramsReasoningEffort) {
    candidate = mapToAgyThoughtLevel(paramsReasoningEffort);
  } else if (savedProviderEffort && savedProviderEffort !== "none") {
    candidate = savedProviderEffort;
  } else if (savedProviderEffort === "none") {
    candidate = "low";
  } else if (paramsReasoningEffort) {
    candidate = mapToAgyThoughtLevel(paramsReasoningEffort);
  }

  if (candidate) {
    if (maxEffort) {
      return capReasoningLevel(candidate as ReasoningLevel, maxEffort);
    }
    return candidate;
  }

  if (maxEffort && (maxEffort === "low" || maxEffort === "medium")) {
    return maxEffort;
  }

  return null;
}

/**
 * Read the model selector out of a session's `configOptions`. The option is
 * the one with category `model` (or id `model`) and type `select`. Grouped
 * option lists are flattened. Null when the CLI offers no model selector.
 */
export function modelOptionsOf(
  configOptions: unknown,
): AntigravityModelOptions | null {
  if (!Array.isArray(configOptions)) return null;
  const option = configOptions.find(
    (o): o is Record<string, unknown> =>
      typeof o === "object" &&
      o !== null &&
      ((o as { category?: unknown }).category === "model" ||
        (o as { id?: unknown }).id === "model") &&
      (o as { type?: unknown }).type === "select",
  );
  if (!option || typeof option.id !== "string") return null;
  if (!Array.isArray(option.options)) return null;

  const entries: unknown[] = [];
  for (const entry of option.options as unknown[]) {
    if (typeof entry === "object" && entry !== null && "options" in entry) {
      const group = (entry as { options?: unknown }).options;
      if (Array.isArray(group)) entries.push(...group);
    } else {
      entries.push(entry);
    }
  }

  const models: AntigravityModel[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { value, name } = entry as { value?: unknown; name?: unknown };
    if (typeof value !== "string" || value.length === 0) continue;
    models.push({
      id: value,
      name: typeof name === "string" && name.length > 0 ? name : value,
    });
  }

  return {
    configId: option.id,
    models,
    currentModel:
      typeof option.currentValue === "string" ? option.currentValue : null,
  };
}

export const AGY_LEVEL_ORDER: Record<string, number> = {
  off: 1,
  none: 1,
  low: 1,
  medium: 2,
  high: 3,
};

export function agyLevelRank(level: string | null | undefined): number | null {
  if (!level) return null;
  const key = level.trim().toLowerCase();
  return AGY_LEVEL_ORDER[key] ?? null;
}

/**
 * Make the session use `model`. The model must be one the CLI offers in this
 * session, otherwise the call fails before any prompt is sent.
 */
export async function selectModel(
  connection: AcpConnection,
  sessionId: string,
  options: AntigravityModelOptions | null,
  model: string,
): Promise<{ configOptions?: unknown }> {
  if (!options || !options.models.some((m) => m.id === model)) {
    throw new AntigravityError(
      "Antigravity model is not available",
      ANTIGRAVITY_ERRORS.MODEL_UNAVAILABLE,
    );
  }
  if (options.currentModel === model) return {};
  const res = resultOrThrow<{ configOptions?: unknown }>(
    await connection.call(
      "session/set_config_option",
      { sessionId, configId: options.configId, value: model },
      SETUP_TIMEOUT_MS,
    ),
    ANTIGRAVITY_ERRORS.SESSION_FAILED,
    "Antigravity model could not be selected",
  );
  return res ?? {};
}

/**
 * Configure thought level via session/set_config_option if advertised.
 * Safe compatibility: if options is null (older agy or model with no selector), returns null without error.
 * If target level is unsupported:
 * - If mandatory cap (policyCap) is set: picks highest advertised level at or below cap,
 *   or fails closed with AntigravityError if no advertised level satisfies cap.
 * - If uncapped: preserves current CLI value without sending set_config_option.
 * If target level is identical to current, avoids redundant call.
 */
export async function selectThoughtLevel(
  connection: AcpConnection,
  sessionId: string,
  options: AntigravityThoughtLevelOptions | null,
  targetLevel: string | null,
  policyCap?: ReasoningLevel | null,
): Promise<{ appliedLevel: string | null; configOptions?: unknown }> {
  if (!options) return { appliedLevel: null };

  const capRank = agyLevelRank(policyCap);

  let selected: string | null = null;

  if (targetLevel && options.choices.includes(targetLevel)) {
    const targetRank = agyLevelRank(targetLevel) ?? Infinity;
    if (capRank === null || targetRank <= capRank) {
      selected = targetLevel;
    }
  }

  if (!selected) {
    if (capRank !== null) {
      const compatibleChoices = options.choices.filter((c) => {
        const rank = agyLevelRank(c);
        return rank !== null && rank <= capRank;
      });
      if (compatibleChoices.length === 0) {
        throw new AntigravityError(
          "Antigravity thought level could not be selected",
          ANTIGRAVITY_ERRORS.SESSION_FAILED,
        );
      }
      const currentRank = agyLevelRank(options.currentLevel) ?? Infinity;
      if (!targetLevel && currentRank <= capRank && options.currentLevel) {
        selected = options.currentLevel;
      } else {
        compatibleChoices.sort(
          (a, b) => (agyLevelRank(b) ?? 0) - (agyLevelRank(a) ?? 0),
        );
        selected = compatibleChoices[0];
      }
    } else {
      selected = options.currentLevel;
    }
  }

  if (!selected) {
    return { appliedLevel: options.currentLevel };
  }

  if (options.currentLevel === selected) {
    return { appliedLevel: selected };
  }

  const res = resultOrThrow<{ configOptions?: unknown }>(
    await connection.call(
      "session/set_config_option",
      { sessionId, configId: options.configId, value: selected },
      SETUP_TIMEOUT_MS,
    ),
    ANTIGRAVITY_ERRORS.SESSION_FAILED,
    "Antigravity thought level could not be selected",
  );
  const updatedOptions = thoughtLevelOptionsOf(res?.configOptions);
  if (capRank !== null) {
    if (!updatedOptions || !updatedOptions.currentLevel) {
      throw new AntigravityError(
        "Antigravity thought level could not be selected",
        ANTIGRAVITY_ERRORS.SESSION_FAILED,
      );
    }
    const updatedRank = agyLevelRank(updatedOptions.currentLevel);
    if (
      updatedRank === null ||
      updatedRank > capRank ||
      updatedOptions.currentLevel !== selected
    ) {
      throw new AntigravityError(
        "Antigravity thought level could not be selected",
        ANTIGRAVITY_ERRORS.SESSION_FAILED,
      );
    }
  }
  return {
    appliedLevel: updatedOptions?.currentLevel ?? selected,
    configOptions: res?.configOptions,
  };
}
