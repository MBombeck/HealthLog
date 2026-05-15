/**
 * Shared message-bundle map and nested-key resolver used by both the
 * client-side `I18nProvider` in `context.tsx` and the server-side
 * `getServerTranslator()` in `server-translator.ts`.
 *
 * v1.4.27 B7 / BL-P4-11-S10 — the two surfaces previously each carried
 * their own private copy of `allMessages` plus a near-identical
 * `resolveKey` helper. The maps drifted twice during v1.4.18 / v1.4.25
 * polishing passes when a new locale was added; pinning both call-sites
 * to the same import keeps client and server fallback semantics in
 * lockstep and shrinks the surface a future locale addition has to
 * touch from two to one.
 */
import deMessages from "../../../messages/de.json";
import enMessages from "../../../messages/en.json";
import frMessages from "../../../messages/fr.json";
import esMessages from "../../../messages/es.json";
import itMessages from "../../../messages/it.json";
import plMessages from "../../../messages/pl.json";
import { type Locale } from "./config";

/**
 * Single source of truth for the per-locale message bundle.
 *
 * Both the client provider and the server translator import this map.
 * The bundles ship as static JSON imports so they tree-shake into the
 * client chunk that needs them and into the server chunk that needs
 * them without duplicating.
 */
export const allMessages: Record<Locale, Record<string, unknown>> = {
  de: deMessages,
  en: enMessages,
  fr: frMessages,
  es: esMessages,
  it: itMessages,
  pl: plMessages,
};

/**
 * Resolve a dotted key (`nav.dashboard`) inside a flat-or-nested
 * message object. Returns `undefined` when the key path doesn't land
 * on a string leaf so the caller can chain a fallback bundle (English,
 * raw key) without ambiguity.
 */
export function resolveKey(
  messages: Record<string, unknown>,
  key: string,
): string | undefined {
  const parts = key.split(".");
  let current: unknown = messages;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}
