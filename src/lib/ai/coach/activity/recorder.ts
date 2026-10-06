/**
 * v1.41 — the live trail of one Coach turn: the recorder the loop reports
 * to (implements `contract.ts`).
 *
 * Each entry is opened before its phase starts, updated while it runs and
 * closed with its status and duration. Every change goes out at once as an
 * `activity` frame, upserted by id on the client, so the status line moves
 * while the turn runs. Model text (a reasoning title, a summary, a
 * checkpoint sentence) is screened here before it goes anywhere; text that
 * fails keeps the entry on its catalog label.
 *
 * At the end the recorder hands back the plaintext metadata for
 * `metricSource.activity` and the model text for `trail_encrypted`, held to
 * `TRAIL_MAX_BYTES` by dropping the oldest texts first.
 */
import type {
  CoachActivity,
  CoachActivityMeta,
  CoachStepStatus,
  CoachTrail,
} from "@/lib/ai/coach/types";

import {
  ACTIVITY_MAX_ENTRIES,
  TRAIL_MAX_BYTES,
  type ActivityPatch,
  type ActivityRecorder,
  type ActivityStart,
} from "./contract";
import {
  screenActivityText,
  screenActivityTitle,
  type ActivityScreenContext,
} from "./screen";

interface Entry {
  meta: CoachActivityMeta;
  title?: string;
  text?: string;
  startedAt: number;
}

/** The recorder a chat turn holds: the contract plus the trail's extras. */
export interface TurnActivityRecorder extends ActivityRecorder {
  /** The facts recalled into the turn, owner-only, for the `memory` entry. */
  setRecalled(facts: readonly string[]): void;
  /** The fact proposal's text, which a `memoryDecision` reads back. */
  setProposal(proposal: NonNullable<CoachTrail["proposal"]>): void;
  /** Whether any entry has been opened. */
  started(): boolean;
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function createActivityRecorder(args: {
  /** Sends one frame; a throw is swallowed (the trail never breaks a turn). */
  emit: (activity: CoachActivity) => void;
  screen: ActivityScreenContext;
  now?: () => number;
}): TurnActivityRecorder {
  const now = args.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let recalled: string[] = [];
  let proposal: CoachTrail["proposal"];

  const send = (entry: Entry) => {
    try {
      args.emit({
        ...entry.meta,
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.text ? { text: entry.text } : {}),
      });
    } catch {
      // Progress is best-effort; the answer is not.
    }
  };

  const apply = (entry: Entry, patch: ActivityPatch | undefined) => {
    if (!patch) return;
    if (patch.labelKey !== undefined && patch.label !== undefined) {
      entry.meta.labelKey = patch.labelKey;
      entry.meta.label = patch.label;
    }
    if (patch.count !== undefined && Number.isSafeInteger(patch.count)) {
      entry.meta.count = Math.max(0, patch.count);
    }
    if (patch.title !== undefined) {
      const title = screenActivityTitle(patch.title, args.screen);
      if (title) entry.title = title;
    }
    if (patch.text !== undefined) {
      const text = screenActivityText(patch.text, args.screen);
      if (text) entry.text = text;
    }
  };

  return {
    start(start: ActivityStart) {
      if (entries.size >= ACTIVITY_MAX_ENTRIES) return "";
      const id = `a${entries.size + 1}`;
      const entry: Entry = {
        meta: {
          id,
          phase: start.phase,
          status: "running",
          round: Math.max(1, Math.floor(start.round)),
          labelKey: start.labelKey,
          label: start.label,
          ...(start.stepRef ? { stepRef: start.stepRef } : {}),
          ...(start.count !== undefined && Number.isSafeInteger(start.count)
            ? { count: Math.max(0, start.count) }
            : {}),
          ...(start.stop ? { stop: start.stop } : {}),
        },
        startedAt: now(),
      };
      entries.set(id, entry);
      send(entry);
      return id;
    },
    update(id, patch) {
      const entry = entries.get(id);
      if (!entry || entry.meta.status !== "running") return;
      apply(entry, patch);
      send(entry);
    },
    finish(id, status: Exclude<CoachStepStatus, "running">, patch) {
      const entry = entries.get(id);
      if (!entry || entry.meta.status !== "running") return;
      apply(entry, patch);
      entry.meta.status = status;
      entry.meta.durationMs = Math.max(0, Math.round(now() - entry.startedAt));
      send(entry);
    },
    meta: () => [...entries.values()].map((entry) => ({ ...entry.meta })),
    trail() {
      const withText = [...entries.values()].filter(
        (entry) => entry.title || entry.text,
      );
      if (withText.length === 0 && recalled.length === 0 && !proposal) {
        return null;
      }
      const trail: CoachTrail = {
        entries: withText.map((entry) => ({
          id: entry.meta.id,
          ...(entry.title ? { title: entry.title } : {}),
          ...(entry.text ? { text: entry.text } : {}),
        })),
        ...(recalled.length > 0 ? { recalled: [...recalled] } : {}),
        ...(proposal ? { proposal } : {}),
      };
      // Over the ceiling: the oldest texts go first, then the oldest titles,
      // then the recalled facts. The proposal is what a tap reads back, so
      // it stays.
      for (const field of ["text", "title"] as const) {
        for (const entry of trail.entries) {
          if (bytes(trail) <= TRAIL_MAX_BYTES) return trail;
          delete entry[field];
        }
      }
      trail.entries = trail.entries.filter((e) => e.title || e.text);
      if (bytes(trail) > TRAIL_MAX_BYTES) delete trail.recalled;
      return trail;
    },
    setRecalled(facts) {
      recalled = facts.filter((fact) => fact.length > 0).slice(0, 12);
    },
    setProposal(next) {
      proposal = next;
    },
    started: () => entries.size > 0,
  };
}
