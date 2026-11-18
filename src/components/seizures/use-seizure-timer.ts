"use client";

/**
 * The quick log's timer (#1368).
 *
 * The timer stores WHEN it started, never a ticking count: the elapsed time is
 * always `now - startedAt`, so a reload, a locked phone or a browser that
 * froze the tab in the background picks up at the right second. The start,
 * the chosen type and any rescue dose stamped while it ran live in
 * `localStorage` under the record's id, so the carer of one person never sees
 * another's timer. Storage can be missing (a private window) or throw; the
 * timer then still runs for as long as the page is open.
 */
import { useCallback, useEffect, useState } from "react";

export interface TimerRescueStamp {
  givenAt: string;
  medicationId: string | null;
  medicationName: string | null;
  doseAmount: number | null;
  doseUnit: string | null;
  route: string | null;
}

export interface SeizureTimerState {
  /** ISO instant the timer was started. */
  startedAt: string;
  typeProfileId: string | null;
  rescue: TimerRescueStamp[];
}

const PREFIX = "healthlog:seizure-timer:";

export function timerStorageKey(recordId: string): string {
  return `${PREFIX}${recordId}`;
}

function read(recordId: string): SeizureTimerState | null {
  try {
    const raw = window.localStorage.getItem(timerStorageKey(recordId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SeizureTimerState>;
    if (
      typeof parsed.startedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.startedAt))
    ) {
      return null;
    }
    return {
      startedAt: parsed.startedAt,
      typeProfileId:
        typeof parsed.typeProfileId === "string" ? parsed.typeProfileId : null,
      rescue: Array.isArray(parsed.rescue) ? parsed.rescue : [],
    };
  } catch {
    return null;
  }
}

function write(recordId: string, state: SeizureTimerState | null): void {
  try {
    if (state === null) {
      window.localStorage.removeItem(timerStorageKey(recordId));
    } else {
      window.localStorage.setItem(
        timerStorageKey(recordId),
        JSON.stringify(state),
      );
    }
  } catch {
    // Storage unavailable: the in-memory state still carries the timer.
  }
}

export function elapsedSeconds(startedAt: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
}

/**
 * The timer of one record. The caller keys the component by the record, so a
 * switch to another record mounts a fresh hook that reads that record's timer.
 */
export function useSeizureTimer(recordId: string | null) {
  // A timer left running by a reload or a locked phone is picked up at mount.
  const [state, setState] = useState<SeizureTimerState | null>(() =>
    recordId && typeof window !== "undefined" ? read(recordId) : null,
  );
  const [now, setNow] = useState(() => Date.now());

  // Follow a timer started or stopped in another tab of this record.
  useEffect(() => {
    if (!recordId) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === timerStorageKey(recordId)) setState(read(recordId));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [recordId]);

  // Tick once a second while running, and catch up the moment the page is
  // shown again after the phone was locked.
  useEffect(() => {
    if (!state) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => setNow(Date.now());
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state]);

  const update = useCallback(
    (next: SeizureTimerState | null) => {
      setState(next);
      if (recordId) write(recordId, next);
    },
    [recordId],
  );

  const start = useCallback(
    (typeProfileId: string | null) => {
      const at = new Date().toISOString();
      setNow(Date.parse(at));
      update({ startedAt: at, typeProfileId, rescue: [] });
    },
    [update],
  );

  const setType = useCallback(
    (typeProfileId: string | null) => {
      if (state) update({ ...state, typeProfileId });
    },
    [state, update],
  );

  const stampRescue = useCallback(
    (stamp: Omit<TimerRescueStamp, "givenAt">) => {
      if (!state) return;
      update({
        ...state,
        rescue: [
          ...state.rescue,
          { ...stamp, givenAt: new Date().toISOString() },
        ],
      });
    },
    [state, update],
  );

  const clear = useCallback(() => update(null), [update]);

  return {
    state,
    running: state !== null,
    elapsed: state ? elapsedSeconds(state.startedAt, now) : 0,
    start,
    setType,
    stampRescue,
    clear,
  };
}
