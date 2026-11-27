/**
 * The local-storage keys one-time hints were dismissed under before the
 * dismissal moved to the account (`dismissible-hints.ts`). Read once per
 * page load by `useDismissedHints`, sent to the account, then forgotten, so
 * a hint closed in this browser before the move stays closed.
 *
 * Every access is wrapped: storage can be absent, blocked or throw, and the
 * carry-over then simply finds nothing.
 */
import {
  CHECKLIST_DISMISSED_ALL_KEY,
  CHECKLIST_DISMISSED_ITEMS_KEY,
} from "@/lib/onboarding/checklist-storage";
import { locales } from "@/lib/i18n/config";

import { hintId, isDismissibleHintId } from "./dismissible-hints";

/** Per-viewer keys: `<prefix>.<viewerId>` held `"1"`. */
const PER_VIEWER = [
  ["healthlog.ai-setup-hint.dismissed", "ai-setup"],
  ["healthlog.ai-consent-request.dismissed", "ai-consent-request"],
  ["healthlog.correlation-seasonal-note.dismissed", "correlation-seasonal"],
] as const;

/** The timeline readiness card's key; held `true` as JSON. */
const READINESS_CARD_DISMISSED_KEY = "healthlog.timeline.readinessCard";

/** Per-language keys: `<prefix><locale>` held `"1"`. */
const I18N_BANNER_PREFIX = "healthlog-i18n-banner-dismissed:";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The hint ids this browser had dismissed for `viewerId`, and a `forget`
 * that removes the keys they came from.
 */
export function readLegacyDismissals(viewerId: string): {
  ids: string[];
  forget: () => void;
} {
  const store = storage();
  if (!store) return { ids: [], forget: () => {} };
  const ids: string[] = [];
  const keys: string[] = [];
  const read = (key: string): string | null => {
    try {
      return store.getItem(key);
    } catch {
      return null;
    }
  };
  const take = (key: string, id: string) => {
    keys.push(key);
    if (isDismissibleHintId(id)) ids.push(id);
  };

  for (const [prefix, family] of PER_VIEWER) {
    const key = `${prefix}.${viewerId}`;
    if (read(key) === "1") take(key, family);
  }
  for (const locale of locales) {
    const key = `${I18N_BANNER_PREFIX}${locale}`;
    if (read(key) === "1") take(key, hintId("i18n-banner", locale));
  }
  if (read(READINESS_CARD_DISMISSED_KEY) === "true") {
    take(READINESS_CARD_DISMISSED_KEY, "timeline-readiness");
  }
  if (read(CHECKLIST_DISMISSED_ALL_KEY) === "1") {
    take(CHECKLIST_DISMISSED_ALL_KEY, "getting-started");
  }
  const rows = read(CHECKLIST_DISMISSED_ITEMS_KEY);
  if (rows !== null) {
    keys.push(CHECKLIST_DISMISSED_ITEMS_KEY);
    try {
      const parsed: unknown = JSON.parse(rows);
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (typeof row !== "string") continue;
          const id = hintId("getting-started", row);
          if (isDismissibleHintId(id)) ids.push(id);
        }
      }
    } catch {
      // A corrupt list carries nothing over.
    }
  }

  return {
    ids,
    forget: () => {
      for (const key of keys) {
        try {
          store.removeItem(key);
        } catch {
          // Storage unavailable: the next load finds them again, harmlessly.
        }
      }
    },
  };
}
