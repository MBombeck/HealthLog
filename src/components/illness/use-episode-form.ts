"use client";

/**
 * The illness episode form's fields, plus the reset that runs when the sheet
 * opens: an edit starts from the stored episode, a new episode from today's
 * date. Split out of `<NewEpisodeSheet>` so the sheet keeps the layout and
 * `use-episode-save` keeps the save lifecycle.
 */
import { useState } from "react";

import type { BodySiteSideValue } from "@/components/body-sites/body-site-fields";

import { toLocalDateKey } from "./dates";
import type { IllnessEpisodeDTO, IllnessLifecycle, IllnessType } from "./types";

export interface EpisodeFormController {
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
  setLabel: (value: string) => void;
  setType: (value: IllnessType) => void;
  setLifecycle: (value: IllnessLifecycle) => void;
  setOnset: (value: string) => void;
  setResolved: (value: string) => void;
  setParentId: (value: string | null) => void;
  setNote: (value: string) => void;
  setBodySite: (value: string) => void;
  setLaterality: (value: BodySiteSideValue) => void;
}

export function useEpisodeForm({
  open,
  editEpisode,
  timeZone,
  today,
}: {
  open: boolean;
  editEpisode?: IllnessEpisodeDTO;
  timeZone: string;
  /** Today as `YYYY-MM-DD` in the viewer's calendar — the new-episode default. */
  today: string;
}): EpisodeFormController {
  const [label, setLabel] = useState(editEpisode?.label ?? "");
  const [type, setType] = useState<IllnessType>(
    editEpisode?.type ?? "INFECTION",
  );
  const [lifecycle, setLifecycle] = useState<IllnessLifecycle>(
    editEpisode?.lifecycle ?? "ACUTE",
  );
  const [onset, setOnset] = useState(
    editEpisode ? toLocalDateKey(editEpisode.onsetAt, timeZone) : today,
  );
  // Resolved/end date — "" means the episode is still ongoing (open-ended).
  // Backdating both onset and this end date lets a whole past episode be
  // recorded after the fact.
  const [resolved, setResolved] = useState(
    editEpisode?.resolvedAt
      ? toLocalDateKey(editEpisode.resolvedAt, timeZone)
      : "",
  );
  const [parentId, setParentId] = useState<string | null>(
    editEpisode?.parentConditionId ?? null,
  );
  const [note, setNote] = useState(editEpisode?.note ?? "");
  // Where on the body. Offered on every type: an injury or a joint condition is
  // the usual case, but nothing about a type rules a site out.
  const [bodySite, setBodySite] = useState(editEpisode?.bodySite ?? "");
  const [laterality, setLaterality] = useState<BodySiteSideValue>(
    editEpisode?.laterality ?? null,
  );

  // Reset / hydrate the form each time the sheet opens — adjusted during
  // render keyed on the open transition (React's recommended alternative to a
  // setState-in-effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open && !wasOpen) {
    setWasOpen(true);
    setLabel(editEpisode?.label ?? "");
    setType(editEpisode?.type ?? "INFECTION");
    setLifecycle(editEpisode?.lifecycle ?? "ACUTE");
    setOnset(
      editEpisode ? toLocalDateKey(editEpisode.onsetAt, timeZone) : today,
    );
    setResolved(
      editEpisode?.resolvedAt
        ? toLocalDateKey(editEpisode.resolvedAt, timeZone)
        : "",
    );
    setParentId(editEpisode?.parentConditionId ?? null);
    setNote(editEpisode?.note ?? "");
    setBodySite(editEpisode?.bodySite ?? "");
    setLaterality(editEpisode?.laterality ?? null);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  return {
    label,
    type,
    lifecycle,
    onset,
    resolved,
    parentId,
    note,
    bodySite,
    laterality,
    setLabel,
    setType,
    setLifecycle,
    setOnset,
    setResolved,
    setParentId,
    setNote,
    setBodySite,
    setLaterality,
  };
}
