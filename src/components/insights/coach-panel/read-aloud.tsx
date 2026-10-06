"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Volume2, VolumeX } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { stripChartTokens } from "@/lib/insights/chart-tokens";

/**
 * Read-aloud + capability detection for the Coach message thread, split
 * out of `message-thread.tsx` (v1.28.26 file-size split — pure code
 * motion, no behaviour change). Owns the SSR-safe Speech-Synthesis /
 * Clipboard feature detection, the natural-voice ranking, the
 * `useReadAloud` hook, and the per-message read-aloud button, plus the
 * shared icon-button styling the sibling action buttons reuse.
 */

/**
 * v1.22 (W5) — feature-detect the browser Speech Synthesis API SSR-safe.
 * `useSyncExternalStore` returns false on the server + first client paint
 * (so the read-aloud button is absent in markup) and resolves to the real
 * capability after hydration, mirroring the mic button's detection pattern
 * — no hydration mismatch warning, no `connect-src` (it runs in-browser).
 */
function useSpeechSynthesisSupported(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () =>
      typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      "SpeechSynthesisUtterance" in window,
    () => false,
  );
}

/**
 * v1.22.1 — feature-detect the async Clipboard API SSR-safe, mirroring the
 * Speech-Synthesis detection above. `navigator.clipboard` is `undefined` on
 * plain-HTTP self-hosts (a supported insecure-context config), so the copy
 * button must be absent there rather than rendering and error-toasting on tap.
 * `useSyncExternalStore` returns false on the server + first client paint and
 * resolves to the real capability after hydration — no hydration mismatch.
 */
export function useClipboardSupported(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () =>
      typeof navigator !== "undefined" &&
      typeof navigator.clipboard?.writeText === "function",
    () => false,
  );
}

/**
 * v1.22 — score a synthesis voice for a target language. Higher is better;
 * a negative score marks a legacy/compact voice we would rather skip. Pure
 * (no browser globals) so the ranking contract is unit-testable. Exported
 * for the read-aloud voice-selection test.
 *
 * The default OS voice is often a legacy "compact" engine (Anna, Albert,
 * Zarvox, eSpeak) that reads robotically. We prefer, in order: an Apple
 * enhanced/premium or Siri voice, a Microsoft "Natural"/"Online" (Edge)
 * voice, a "Google …" (Chrome) voice, and a small set of known-good names
 * (Samantha). An exact lang-REGION match (de-DE/en-US) outweighs a bare
 * language match. `localService` only breaks a tie. Known-bad names are
 * penalised so they never win over a neutral remote voice.
 */
export function scoreSpeechVoice(
  voice: { name: string; lang: string; localService?: boolean },
  lang: string,
): number {
  const base = lang.split("-")[0].toLowerCase();
  const vlang = voice.lang.toLowerCase().replace("_", "-");
  if (!vlang.startsWith(base)) return -Infinity;
  const name = voice.name.toLowerCase();
  let score = 0;

  // Exact lang-REGION match (de-DE, en-US) over a bare language match.
  if (lang.includes("-") && vlang === lang.toLowerCase()) score += 40;

  // High-quality engines.
  if (/\b(enhanced|premium)\b/.test(name)) score += 60;
  if (name.includes("siri")) score += 55;
  if (name.includes("natural") || name.includes("online")) score += 50;
  if (name.startsWith("google")) score += 35;
  if (name.includes("samantha")) score += 30;

  // Known-bad legacy / compact engines.
  if (name.includes("compact")) score -= 80;
  if (/\b(albert|zarvox|espeak|anna|fred|ralph|bahh|trinoids)\b/.test(name)) {
    score -= 100;
  }

  // Tie-breaker only: a local voice has no network latency.
  if (voice.localService) score += 1;

  return score;
}

/**
 * v1.22 — pick the best-scoring installed voice for `lang`, or null when
 * none beats a legacy/compact default (graceful fallback to the browser
 * default). Pure helper, exported for the ranking test.
 */
export function pickSpeechVoice(
  voices: SpeechSynthesisVoice[],
  lang: string,
): SpeechSynthesisVoice | null {
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = 0; // require a positive score to override the default
  for (const v of voices) {
    const s = scoreSpeechVoice(v, lang);
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }
  return best;
}

/**
 * v1.22 (W5) — read the assistant prose aloud via the browser's
 * `SpeechSynthesis`. Client-only, no dependency, no egress, CSP-clean. A
 * single in-flight utterance: a new `speak` cancels any prior one; `toggle`
 * stops while speaking.
 *
 * v1.22 — natural-voice selection. The browser default is frequently a
 * legacy/compact engine that reads robotically; instead of only stamping
 * `utterance.lang` we enumerate `getVoices()`, rank the candidates for the
 * locale (`pickSpeechVoice`), and assign the winner. The voice list is async
 * (empty on the first call, and on iOS Safari it can stay empty until the
 * first user-gesture speak), so we subscribe to `voiceschanged` and also
 * re-read it lazily on the first toggle. The chosen voice is cached per
 * locale in a ref so the ranking runs once.
 */
function useReadAloud(): {
  supported: boolean;
  speaking: boolean;
  toggle: (text: string, lang: string) => void;
} {
  const supported = useSpeechSynthesisSupported();
  const [speaking, setSpeaking] = useState(false);
  // Cache the resolved voice per locale so the ranking runs once.
  const voiceByLocaleRef = useRef<Map<string, SpeechSynthesisVoice | null>>(
    new Map(),
  );

  // Pre-warm the voice list + keep it fresh: the list arrives asynchronously
  // and `voiceschanged` fires when the OS finishes loading installed voices.
  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const refresh = () => {
      // A late-arriving list can surface a better voice than an early read;
      // clear the cache so the next toggle re-ranks against the full set.
      voiceByLocaleRef.current.clear();
    };
    synth.getVoices();
    synth.addEventListener?.("voiceschanged", refresh);
    return () => synth.removeEventListener?.("voiceschanged", refresh);
  }, [supported]);

  // Stop any in-flight utterance if the bubble unmounts (thread reset, nav).
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const resolveVoice = useCallback(
    (synth: SpeechSynthesis, lang: string): SpeechSynthesisVoice | null => {
      const cached = voiceByLocaleRef.current.get(lang);
      if (cached !== undefined) return cached;
      const voices = synth.getVoices();
      // An empty list (first call / iOS pre-gesture) is not cached so a later
      // toggle re-ranks once the OS has populated the voices.
      if (voices.length === 0) return null;
      const chosen = pickSpeechVoice(voices, lang);
      voiceByLocaleRef.current.set(lang, chosen);
      return chosen;
    },
    [],
  );

  const toggle = useCallback(
    (text: string, lang: string) => {
      if (!supported) return;
      const synth = window.speechSynthesis;
      if (speaking) {
        synth.cancel();
        setSpeaking(false);
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) return;
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(trimmed);
      const voice = resolveVoice(synth, lang);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = lang;
      }
      // A natural cadence: default rate, neutral pitch.
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      setSpeaking(true);
      synth.speak(utterance);
    },
    [supported, speaking, resolveVoice],
  );

  return { supported, speaking, toggle };
}

/**
 * v1.22 — shared styling for the icon-only per-message action buttons. One
 * tap convention across Copy / Read-aloud / feedback / Try-again: a 44px
 * mobile tap floor (WCAG 2.5.5) collapsing to a compact 32px desktop target,
 * muted until hover/focus, with the Coach's neutral focus ring.
 */
export const COACH_ICON_BUTTON = cn(
  "text-muted-foreground hover:text-foreground focus-visible:ring-input-focus",
  "inline-flex size-11 min-w-11 shrink-0 items-center justify-center rounded",
  "outline-none focus-visible:ring-2 disabled:opacity-50 sm:size-8 sm:min-w-8",
);

/**
 * v1.22 (W5) — read-aloud toggle for a settled assistant turn. Hidden when
 * the browser has no Speech Synthesis support. Speaks `stripChartTokens`
 * (the same text the prose shows), so stray tokens are never voiced.
 */
export function ReadAloudButton({ content }: { content: string }) {
  const { t, locale } = useTranslations();
  const { supported, speaking, toggle } = useReadAloud();
  if (!supported) return null;
  const label = speaking
    ? t("insights.coach.readAloudStop")
    : t("insights.coach.readAloud");
  return (
    <button
      type="button"
      data-slot="coach-read-aloud"
      onClick={() => toggle(stripChartTokens(content), locale)}
      aria-label={label}
      aria-pressed={speaking}
      title={label}
      className={COACH_ICON_BUTTON}
    >
      {speaking ? (
        <VolumeX className="size-4" aria-hidden="true" />
      ) : (
        <Volume2 className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}
