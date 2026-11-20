/**
 * The `client_version` the Codex model-list read sends.
 *
 * The backend leaves out every model whose `minimal_client_version` is above
 * the version named, so a version behind the current Codex CLI hides models
 * the account actually has. The default covers the newest line known when it
 * was last moved (the gpt-6.2 models name 0.166.0 and 0.170.0). An operator can follow a newer Codex release without
 * waiting for a HealthLog update by setting `CODEX_CLIENT_VERSION`.
 *
 * Nothing is looked up at runtime: the version is this constant or the
 * operator's value, never a registry read.
 */
import { emitSignal } from "@/lib/logging/signal";

export const CODEX_DEFAULT_CLIENT_VERSION = "0.170.0";

const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/;

/** The invalid value already reported, so the warning is written once. */
let reportedInvalid: string | null = null;

/**
 * `CODEX_CLIENT_VERSION` when it is a plain `x.y.z`, else the default. An
 * invalid value is ignored and reported once (its length only, never the
 * value).
 */
export function codexModelsClientVersion(): string {
  const raw = process.env.CODEX_CLIENT_VERSION?.trim();
  if (!raw) return CODEX_DEFAULT_CLIENT_VERSION;
  if (PLAIN_SEMVER.test(raw)) return raw;
  if (reportedInvalid !== raw) {
    reportedInvalid = raw;
    emitSignal({
      action: "ai.codex.client_version_invalid",
      level: "warn",
      meta: { length: raw.length, fallback: CODEX_DEFAULT_CLIENT_VERSION },
    });
  }
  return CODEX_DEFAULT_CLIENT_VERSION;
}

/** Test-only: forget which invalid value was reported. */
export function resetCodexClientVersionWarning(): void {
  reportedInvalid = null;
}
