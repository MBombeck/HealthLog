"use client";

/**
 * The illness episode save lifecycle: duplicate-submit and stale-request
 * guards, the error strip's state, and the session timezone the dates are
 * serialized in. Kept out of `<NewEpisodeSheet>` so the sheet stays a form and
 * this state machine can be read on its own.
 */
import { useEffect, useRef, useState } from "react";

import { todayKeyInZone } from "@/components/day/day-url";
import { getUserTodayBounds } from "@/lib/tz/local-day";

import { resolveEpisodeWindow } from "./dates";
import { useCreateEpisode, useUpdateEpisode } from "./use-illness";
import type { IllnessEpisodeDTO, IllnessLifecycle, IllnessType } from "./types";
import type { BodySiteSideValue } from "@/components/body-sites/body-site-fields";

/** Lifecycles that may hang off a parent condition. */
const PARENTABLE: IllnessLifecycle[] = ["FLARE", "RECURRING"];

/** Everything `handleSave` reads from the form. */
export interface EpisodeSaveValues {
  label: string;
  type: IllnessType;
  lifecycle: IllnessLifecycle;
  onset: string;
  resolved: string;
  /** The chosen parent condition, or `null` for none. */
  parentId: string | null;
  note: string;
  bodySite: string;
  laterality: BodySiteSideValue;
}

export function useEpisodeSave({
  open,
  onOpenChange,
  editEpisode,
  timeZone,
  values,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editEpisode?: IllnessEpisodeDTO;
  timeZone: string;
  values: EpisodeSaveValues;
}) {
  const create = useCreateEpisode();
  const update = useUpdateEpisode();
  const isEdit = editEpisode !== undefined;
  const [isSaving, setIsSaving] = useState(false);
  // Duplicate-submit guard within the same session render tick
  const savingGenerationRef = useRef<number | null>(null);
  // Session generation counter. Incremented synchronously in handleOpenChange on close
  // to immediately invalidate in-flight saves, and unconditionally in the [open] effect
  // on open/close prop transitions (including external transitions). Duplicate increments
  // on handler-driven close are harmless because generationRef is compared strictly for equality.
  const generationRef = useRef(0);
  const prevOpenRef = useRef(open);
  const [saveError, setSaveError] = useState(false);
  // The timezone the open sheet serializes in. Snapshotted when the sheet opens so a
  // profile change mid-save cannot move the dates under the request that is in flight.
  const [sessionTimezone, setSessionTimezone] = useState(timeZone);
  const [todayInSession, setTodayInSession] = useState(() =>
    todayKeyInZone(timeZone),
  );

  const { label, type, lifecycle, onset, resolved, parentId, note } = values;
  const { bodySite, laterality } = values;
  // Clear save errors on user edits.
  function clearSaveError() {
    setSaveError(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    generationRef.current += 1;
    savingGenerationRef.current = null;
    setIsSaving(false);
    setSaveError(false);
    onOpenChange(nextOpen);
  }

  // Refresh the session clock when the sheet opens — adjusted during render
  // keyed on the open transition, like the form's own reset.
  const [wasOpen, setWasOpen] = useState(open);
  if (open && !wasOpen) {
    setWasOpen(true);
    setSaveError(false);
    setIsSaving(false);
    setSessionTimezone(timeZone);
    setTodayInSession(todayKeyInZone(timeZone));
  } else if (!open && wasOpen) {
    setWasOpen(false);
    setSaveError(false);
    setIsSaving(false);
  }

  // Run only for sheet open/close transitions (including controlled prop transitions).
  // Unconditionally advances generationRef on controlled open prop transitions (including external
  // transitions). Handler close increments generationRef synchronously so in-flight requests are
  // invalidated immediately; harmless duplicate increments on close are safe since generationRef
  // is compared only for equality.
  useEffect(() => {
    if (prevOpenRef.current !== open) {
      prevOpenRef.current = open;
      generationRef.current += 1;
      savingGenerationRef.current = null;
      setIsSaving(false);
      setSaveError(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function scheduleMidnight() {
      const now = new Date();
      const bounds = getUserTodayBounds(now, sessionTimezone);
      const delay = Math.max(0, bounds.end.getTime() + 1 - now.getTime());
      timer = setTimeout(() => {
        setTodayInSession(todayKeyInZone(sessionTimezone));
        scheduleMidnight();
      }, delay);
    }

    scheduleMidnight();
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [open, sessionTimezone]);

  const showParent = PARENTABLE.includes(lifecycle);
  const trimmedOnset = onset.trim();
  const trimmedResolved = resolved.trim();

  // The end date can never precede the start; the field is min-bounded to the
  // onset, and this guard belts-and-braces the same invariant the server holds.
  const endBeforeStart =
    trimmedResolved !== "" &&
    trimmedOnset !== "" &&
    trimmedResolved < trimmedOnset;

  async function handleSave() {
    if (
      savingGenerationRef.current === generationRef.current ||
      isSaving ||
      label.trim() === "" ||
      trimmedOnset === "" ||
      endBeforeStart
    ) {
      return;
    }
    const saveGeneration = generationRef.current;
    savingGenerationRef.current = saveGeneration;
    setIsSaving(true);
    clearSaveError();
    try {
      const now = new Date();
      const today = todayKeyInZone(sessionTimezone, now);
      // When editing an existing episode, preserve its exact stored onset/resolved instants
      // when their selected calendar dates are unchanged in the active display timezone.
      const { onsetAt, resolvedAt } = resolveEpisodeWindow({
        onset,
        resolved,
        storedOnset: editEpisode?.onsetAt,
        storedResolved: editEpisode?.resolvedAt,
        today,
        now,
        timeZone: sessionTimezone,
      });
      const parentConditionId = showParent ? parentId : null;

      const payload = {
        label: label.trim(),
        type,
        lifecycle,
        onsetAt,
        resolvedAt,
        parentConditionId,
        note: note.trim() === "" ? null : note,
        bodySite: bodySite.trim() || null,
        laterality,
      };
      if (isEdit && editEpisode) {
        await update.mutateAsync({ id: editEpisode.id, input: payload });
      } else {
        await create.mutateAsync(payload);
      }
      if (generationRef.current === saveGeneration) {
        handleOpenChange(false);
      }
      // Generation mismatch: the sheet was closed or reopened while this request was in flight.
      // Stale requests must not close, error, or reset the newer session.
    } catch {
      if (generationRef.current === saveGeneration) {
        // Keep the sheet open; the error strip reports it.
        setSaveError(true);
      }
      // Generation mismatch: stale failure from a previous session is ignored.
    } finally {
      if (generationRef.current === saveGeneration) {
        savingGenerationRef.current = null;
        setIsSaving(false);
      }
    }
  }

  return {
    pending: isSaving,
    saveError,
    sessionTimezone,
    todayInSession,
    showParent,
    trimmedOnset,
    trimmedResolved,
    endBeforeStart,
    handleSave,
    handleOpenChange,
    clearSaveError,
  };
}
