import { Info, KeyRound, type LucideIcon } from "lucide-react";

/**
 * Rows the Settings rail and the Admin rail both carry, because they name the
 * same destination there: the person's About page and the server's, the
 * person's API tokens and the server-wide token list. Part of
 * `SETTINGS_ICONS`, and read by the Admin console directly, so its shell does
 * not carry the whole Settings rail for two glyphs.
 */
export const SHARED_ICONS = {
  apiTokens: KeyRound,
  about: Info,
} as const satisfies Record<string, LucideIcon>;
