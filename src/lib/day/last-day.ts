/**
 * The last day the layer showed, per browser, so the docked day can be shut
 * to a narrow edge and brought back on another page (v1.42).
 *
 * A convenience, not a record: it lives in `localStorage`, every read and
 * write is wrapped because storage can throw (private windows, blocked site
 * data), and an unreadable store means "nothing remembered". The value is
 * bound to the account and the record it was read in (`owner`), so another
 * account on the same browser, or the same person reading a shared record,
 * never gets it back; a session end removes it outright
 * (`clearCachesForSessionEnd`).
 *
 * Beside the day it keeps whether the day was left open (`open`): a page
 * change drops `?day=` from the URL, and the docked column would fold to its
 * edge on every navigation. Open stays open until the person folds or closes
 * it; the layer reopens the remembered day on the next page that docks it.
 *
 * Client-only and free of Zod and server imports, like `contract.ts`.
 */
import type { DateKey } from "@/lib/day/contract";

export const LAST_DAY_STORAGE_KEY = "healthlog.day.last";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Same-tab change signal; the `storage` event only fires in other tabs. */
export const LAST_DAY_CHANGE_EVENT = "healthlog:day-last";

interface Stored {
  owner: string;
  day: DateKey;
  /** Left open by the person; absent in a value an older build wrote. */
  open?: boolean;
}

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStored(
  owner: string | null,
  storage: Pick<Storage, "getItem"> | null,
): Stored | null {
  if (owner === null || !storage) return null;
  try {
    const raw = storage.getItem(LAST_DAY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored> | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.owner !== owner ||
      typeof parsed.day !== "string" ||
      !DATE_KEY.test(parsed.day)
    ) {
      return null;
    }
    return { owner, day: parsed.day, open: parsed.open === true };
  } catch {
    return null;
  }
}

/** The remembered day for `owner`, or null (nothing, someone else's, unreadable). */
export function readLastDay(
  owner: string | null,
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): DateKey | null {
  return readStored(owner, storage)?.day ?? null;
}

/** Whether `owner` left the remembered day open. False when unknown. */
export function readDayOpen(
  owner: string | null,
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): boolean {
  return readStored(owner, storage)?.open === true;
}

function notify() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(LAST_DAY_CHANGE_EVENT));
  }
}

/** Remember `day` as the last one `owner` opened, and as open. Best effort. */
export function writeLastDay(
  owner: string,
  day: DateKey,
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    const held = readStored(owner, storage);
    if (held?.day === day && held.open) return;
    storage.setItem(
      LAST_DAY_STORAGE_KEY,
      JSON.stringify({ owner, day, open: true } satisfies Stored),
    );
  } catch {
    return;
  }
  notify();
}

/**
 * The person folded or closed the day: keep the day for the edge, but do not
 * reopen it on the next page. Best effort.
 */
export function writeDayClosed(
  owner: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    const held = readStored(owner, storage);
    if (!held || !held.open) return;
    storage.setItem(
      LAST_DAY_STORAGE_KEY,
      JSON.stringify({ ...held, open: false } satisfies Stored),
    );
  } catch {
    return;
  }
  notify();
}

/** Forget the remembered day, whoever it belonged to (a session end). */
export function clearLastDay(
  storage: Pick<Storage, "removeItem"> | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(LAST_DAY_STORAGE_KEY);
  } catch {
    return;
  }
  notify();
}

/** For `useSyncExternalStore`: storage changes here and in other tabs. */
export function subscribeLastDay(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === LAST_DAY_STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(LAST_DAY_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LAST_DAY_CHANGE_EVENT, callback);
  };
}
