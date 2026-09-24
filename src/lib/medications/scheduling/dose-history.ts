/**
 * v1.15.18 — traceable dose-history reconstruction (spec B).
 *
 * Builds a complete, attributable ledger for a medication's day(s): every
 * expected slot with a status, plus every off-schedule intake tagged ad-hoc.
 * It is the read-model behind the medication history view + the card's
 * last/next dose, and it converges forward over legacy mis-snapped rows
 * because it attributes a TAKEN intake by its real `takenAt`, not the stored
 * `scheduledFor` the old write path may have snapped to a slot.
 *
 * Attribution rules:
 *   - skipped / auto-missed / pending rows (no `takenAt`) bind to the slot
 *     whose anchor equals their `scheduledFor` (±epsilon): these were written
 *     against a slot deliberately, so they annotate that slot. A pending row
 *     (neither skipped nor auto-missed) is status-derived by time — missed
 *     only past the slot's miss cutoff, upcoming until then — and a pending
 *     row matching no band at all is dropped (server-minted placeholder for
 *     a slot outside the queried window, not a user action);
 *   - a TAKEN intake is attributed by `attributeIntakeToSlot(takenAt, bands)`;
 *     inside a band → that slot (on-time / late), outside every band → ad-hoc;
 *   - a TAKEN intake the user PINNED onto a slot (`pinned`, v1.15.20 —
 *     `attributionSource = USER_PIN`) binds by its `scheduledFor` anchor like
 *     a skip, NOT by takenAt-band membership, so a pin outside the late tail
 *     never degrades back to ad-hoc. Status is `taken_late` unless the
 *     takenAt happens to sit inside the slot's on-time band — a pin can
 *     never flatter the timing;
 *   - a RELEASED pin (v1.16.0 — "Zuordnung lösen" persists `USER_PIN` with
 *     `scheduledFor === takenAt`) is a deliberately ad-hoc take: it never
 *     anchor-binds (not even when its instant sits within epsilon of a slot
 *     anchor) and surfaces as an ad-hoc row carrying `pinned`, never as
 *     `taken_late`;
 *   - each slot is claimed by at most one intake (first/best wins); extra
 *     intakes near a filled slot fall through to ad-hoc;
 *   - a slot anchored before `expectedFrom` (the medication's creation) was
 *     never expected: it appears only when a recorded dose claims it (a
 *     take by band or pin, or a skip). A pending or auto-missed row on such
 *     a slot is the placeholder the today projector mints for every slot of
 *     the creation day, not a user action, so it is dropped rather than
 *     read as a miss or an off-schedule row (#1028).
 *
 * Pure / synchronous / instant-based — the caller mints the bands DST-correctly
 * via `localHmAsUtc` and supplies the per-dose window.
 */
import {
  attributeIntakeToSlot,
  type SlotBand,
} from "@/lib/medications/scheduling/attribution";

/** The minimal intake shape the ledger reads. */
export interface HistoryIntake {
  id?: string;
  /** Stored slot anchor (may be a legacy mis-snapped instant for takes). */
  scheduledFor: Date;
  /** Real intake time, or null for skipped / pending / auto-missed rows. */
  takenAt: Date | null;
  skipped: boolean;
  /** Cron-marked forgotten dose (counts as missed, not skipped). */
  autoMissed?: boolean;
  /**
   * v1.15.20 — `attributionSource === "USER_PIN"`: the user fixed this
   * row's attribution by hand. Pinned onto a slot (`scheduledFor` is the
   * slot anchor): binds by anchor, not by takenAt band. Released
   * (v1.16.0, `scheduledFor === takenAt`): deliberately ad-hoc, never
   * anchor-binds. Optional so legacy callers / fixtures default to AUTO.
   */
  pinned?: boolean;
  /**
   * v1.16.4 — per-intake dose override the user recorded at log time.
   * Optional free text; absent / null = the medication's configured dose
   * applies. Pure pass-through for the read ledger (no status impact).
   */
  doseTaken?: string | null;
  /**
   * v1.32.8 (iOS #64) — write provenance of the stored intake row: `WEB`
   * (browser cookie), `API` (Bearer / native app), `REMINDER` (the Telegram
   * worker), `IMPORT` (CSV importer), `APPLE_HEALTH` (the HealthKit dose-event
   * mirror). Pure pass-through for the read ledger (no status impact); lets a
   * client label how each dose was recorded. Optional so legacy callers /
   * fixtures omit it.
   */
  source?: "WEB" | "API" | "REMINDER" | "IMPORT" | "APPLE_HEALTH";
}

export type DoseHistoryStatus =
  "taken_on_time" | "taken_late" | "skipped" | "missed" | "upcoming" | "ad_hoc";

/**
 * v1.15.20 — the due-context an ad-hoc row carries: the nearest scheduled
 * slot the take COULD belong to, so the UI can show "fällig gewesen: …" and
 * offer "diesem Slot zuordnen" when the slot is still unserved.
 */
export interface NearestSlotContext {
  /** The slot's canonical anchor instant. */
  at: Date;
  /** The slot's "HH:mm" label. */
  timeOfDay: string;
  /**
   * True when the slot cannot be offered for pinning: it is already served
   * by another intake (take / skip), OR the take falls outside the slot's
   * suggestion window (the context is then informational only — "fällig
   * gewesen" renders, the pin action does not).
   */
  filled: boolean;
}

export interface DoseHistoryRow {
  /** A scheduled slot, or a standalone off-schedule intake. */
  kind: "slot" | "ad_hoc";
  /** The slot anchor instant, or the ad-hoc take's own time. */
  at: Date;
  /** The slot's "HH:mm" label, or null for an ad-hoc row. */
  timeOfDay: string | null;
  status: DoseHistoryStatus;
  /** The intake attributed to this row, if any. */
  intake: HistoryIntake | null;
  /**
   * v1.15.20 — true when this slot row is served by a USER_PIN intake (a
   * deliberate "diesem Slot zuordnen" decision). The UI badges it
   * "zugeordnet" and offers "Zuordnung lösen". v1.16.0 — also true on an
   * `ad_hoc` row whose intake is USER_PIN (a released / deliberately
   * ad-hoc take); the UI shows NO badge there (the row is not slot-bound),
   * it only marks the binding as user-fixed.
   */
  pinned?: boolean;
  /**
   * v1.15.20 — for an ad-hoc TAKE only: the nearest scheduled slot in the
   * window (preferring an unserved slot whose suggestion band contains the
   * take). Absent when the medication has no expected slots in the window
   * or the row is an orphaned skip.
   */
  nearestSlot?: NearestSlotContext;
}

/** Sub-minute slop for binding an anchored (skip/pending) row to its slot. */
const ANCHOR_EPSILON_MS = 60_000;

/**
 * Reconstruct the dose-history ledger for the slots described by `bands` and
 * the supplied intakes. Returns rows in chronological order.
 */
export function reconstructDoseHistory(
  bands: SlotBand[],
  intakes: HistoryIntake[],
  now: Date,
  /**
   * The instant from which slots are expected, the medication's creation.
   * Bands anchored earlier appear only when a recorded dose claims them.
   * `null` treats every band as expected (a caller that already minted from
   * the creation instant, or a pure-math fixture).
   */
  expectedFrom: Date | null,
): DoseHistoryRow[] {
  const expectedFromMs = expectedFrom?.getTime() ?? -Infinity;
  const beforeExpected = (at: Date): boolean => at.getTime() < expectedFromMs;
  // Per-band claim: the intake attributed to it + the resolved status.
  const claim = new Map<
    SlotBand,
    { intake: HistoryIntake; status: DoseHistoryStatus; pinned?: boolean }
  >();
  const adHoc: HistoryIntake[] = [];

  // Partition: anchored rows (skip / auto-missed / pending — no takenAt) bind
  // by scheduledFor; PINNED takes (v1.15.20) also bind by scheduledFor (the
  // pin IS the binding decision); unpinned taken rows attribute by real
  // takenAt band membership. Process anchored first so a deliberate
  // skip/miss owns its slot before a stray take could, then pins (a
  // deliberate decision beats band proximity), then band-attributed takes.
  const anchored = intakes.filter((i) => i.takenAt === null);
  const pinnedTaken = intakes.filter((i) => i.takenAt !== null && i.pinned);
  const taken = intakes.filter((i) => i.takenAt !== null && !i.pinned);

  for (const i of anchored) {
    // A pending or auto-missed row before the medication existed records
    // nothing: drop it whether or not its slot was minted.
    if (!i.skipped && beforeExpected(i.scheduledFor)) continue;
    const band = nearestAnchorBand(i.scheduledFor, bands);
    if (band && !claim.has(band)) {
      // Status is time-aware for a pending row: the projector / reminder
      // worker mint pending rows for every slot of the day up front, so a
      // pending row on a slot whose miss cutoff hasn't passed is still
      // takeable — it reads upcoming, not missed (mirrors the unfilled-slot
      // branch below). A skip stays a skip; a cron-marked auto-miss stays
      // missed regardless of the clock.
      const status: DoseHistoryStatus = i.skipped
        ? "skipped"
        : i.autoMissed || now.getTime() > band.overdueEnd.getTime()
          ? "missed"
          : "upcoming";
      claim.set(band, { intake: i, status });
    } else if (i.skipped || i.autoMissed) {
      // A deliberate skip / cron-marked miss with no matching slot (legacy
      // off-grid) — surface it so nothing silently vanishes; tag it ad-hoc.
      adHoc.push(i);
    }
    // A pending row with no matching band is dropped: it is a server-minted
    // placeholder (no user action) for a slot outside the queried band
    // window — e.g. today's evening slot when the caller asked `to = now`.
    // The band set is the source of truth for which slots exist in the
    // window; emitting the placeholder would fabricate a phantom ad-hoc row.
  }

  // v1.15.20 — pinned takes bind by their stored slot anchor, NOT by
  // takenAt-band membership: the whole point of a pin is that the take sits
  // outside (or past the tail of) the band it belongs to. Status never
  // flatters: taken_late, unless the takenAt happens to sit inside the
  // slot's own on-time band anyway. A pin whose slot is gone (schedule
  // changed) or already claimed falls through to ad-hoc so nothing vanishes.
  for (const i of pinnedTaken) {
    // v1.16.0 — a released pin ("Zuordnung lösen") persists USER_PIN with
    // `scheduledFor === takenAt`: the user fixed the attribution as
    // deliberately ad-hoc. Route it straight to ad-hoc — anchor-binding it
    // (its instant can sit within epsilon of a slot anchor) would re-attach
    // the very binding the user released and mislabel the row taken_late.
    if (i.scheduledFor.getTime() === (i.takenAt as Date).getTime()) {
      adHoc.push(i);
      continue;
    }
    const band = nearestAnchorBand(i.scheduledFor, bands);
    if (band && !claim.has(band)) {
      const t = (i.takenAt as Date).getTime();
      const onTime =
        t >= band.onTimeStart.getTime() && t <= band.onTimeEnd.getTime();
      claim.set(band, {
        intake: i,
        status: onTime ? "taken_on_time" : "taken_late",
        pinned: true,
      });
    } else {
      adHoc.push(i);
    }
  }

  for (const i of taken) {
    const matched = attributeIntakeToSlot(i.takenAt as Date, bands);
    if (matched && !claim.has(matched.band)) {
      claim.set(matched.band, {
        intake: i,
        status: matched.status === "on_time" ? "taken_on_time" : "taken_late",
      });
    } else {
      adHoc.push(i);
    }
  }

  // A slot before the medication existed stays absent unless a recorded
  // dose claimed it above.
  const visibleBands = bands.filter(
    (band) => claim.has(band) || !beforeExpected(band.at),
  );

  const rows: DoseHistoryRow[] = visibleBands.map((band) => {
    const c = claim.get(band);
    if (c) {
      return {
        kind: "slot",
        at: band.at,
        timeOfDay: band.timeOfDay,
        status: c.status,
        intake: c.intake,
        ...(c.pinned && { pinned: true }),
      };
    }
    // Unfilled slot: missed only once the miss cutoff (the late tail's end)
    // has passed; until then the dose is still takeable, so it reads upcoming
    // rather than prematurely missed.
    const status: DoseHistoryStatus =
      now.getTime() > band.overdueEnd.getTime() ? "missed" : "upcoming";
    return {
      kind: "slot",
      at: band.at,
      timeOfDay: band.timeOfDay,
      status,
      intake: null,
    };
  });

  for (const i of adHoc) {
    // v1.15.20 — an ad-hoc TAKE carries its due-context: the nearest slot it
    // could belong to, so the UI can show when the dose would have been due
    // and offer "diesem Slot zuordnen" when that slot is still unserved.
    // Orphaned skips (no takenAt) carry no take to attribute, so no context.
    const nearestSlot =
      i.takenAt !== null
        ? suggestNearestSlot(i.takenAt, visibleBands, (band) => claim.has(band))
        : null;
    rows.push({
      kind: "ad_hoc",
      at: i.takenAt ?? i.scheduledFor,
      timeOfDay: null,
      status: "ad_hoc",
      intake: i,
      // v1.16.0 — a USER_PIN intake surfacing ad-hoc (released, or its
      // pinned slot vanished / was claimed) keeps the user-fixed marker.
      ...(i.pinned && { pinned: true }),
      ...(nearestSlot && { nearestSlot }),
    });
  }

  rows.sort((a, b) => a.at.getTime() - b.at.getTime());
  return rows;
}

/**
 * v1.15.20 — the slot an ad-hoc take most plausibly belongs to.
 *
 * Preference order:
 *   1. an UNSERVED slot whose suggestion band contains the take — the band is
 *      the slot's capture zone (`onTimeStart`‥`overdueEnd`) extended past the
 *      tail by 50 % of the tail's length, capped at the next slot's
 *      `onTimeStart` so two adjacent slots' suggestion zones stay disjoint.
 *      Nearest anchor wins among multiple matches;
 *   2. otherwise the nearest slot anchor overall (served or not) — the UI
 *      still shows the "fällig gewesen" context, it just can't offer the pin.
 *
 * Pure; `isFilled` reports whether a band is already claimed by an intake.
 */
export function suggestNearestSlot(
  takenAt: Date,
  bands: SlotBand[],
  isFilled: (band: SlotBand) => boolean,
): NearestSlotContext | null {
  if (bands.length === 0) return null;
  const t = takenAt.getTime();
  const sorted = [...bands].sort((a, b) => a.at.getTime() - b.at.getTime());

  let bestSuggest: { band: SlotBand; dist: number } | null = null;
  let bestAny: { band: SlotBand; dist: number } | null = null;

  for (let i = 0; i < sorted.length; i++) {
    const band = sorted[i];
    const dist = Math.abs(t - band.at.getTime());
    if (bestAny === null || dist < bestAny.dist) {
      bestAny = { band, dist };
    }

    if (isFilled(band)) continue;
    // Suggestion zone: the capture band plus half the late tail again,
    // capped at the following slot's on-time start (disjointness mirrors
    // `buildSlotBands`' overdue cap).
    const tailMs = band.overdueEnd.getTime() - band.onTimeEnd.getTime();
    let suggestEnd = band.overdueEnd.getTime() + tailMs * 0.5;
    const next = sorted[i + 1];
    if (next) suggestEnd = Math.min(suggestEnd, next.onTimeStart.getTime());
    if (t >= band.onTimeStart.getTime() && t <= suggestEnd) {
      if (bestSuggest === null || dist < bestSuggest.dist) {
        bestSuggest = { band, dist };
      }
    }
  }

  // The nearest-anchor fallback only makes sense as due-context when the
  // anchor sits within one cadence step of the take. A take recorded before
  // the schedule's first minted slot (e.g. history predating startsOn) would
  // otherwise pair with a slot days or weeks away and the history row would
  // read "due 09:00 (-1904 h)" — meaningless. Cap the fallback at the band's
  // own capture reach plus one inter-slot gap; beyond that, no due-context.
  if (bestAny && bestSuggest === null) {
    const b = bestAny.band;
    const reach = b.overdueEnd.getTime() - b.onTimeStart.getTime();
    const idx = sorted.indexOf(b);
    const gapMs =
      sorted.length > 1
        ? Math.abs(
            (sorted[Math.min(idx + 1, sorted.length - 1)].at.getTime() ||
              b.at.getTime()) -
              (sorted[Math.max(idx - 1, 0)].at.getTime() || b.at.getTime()),
          ) /
          Math.max(
            1,
            Math.min(idx + 1, sorted.length - 1) - Math.max(idx - 1, 0),
          )
        : reach;
    if (bestAny.dist > reach + gapMs) return null;
  }

  const pick = bestSuggest ?? bestAny;
  if (!pick) return null;
  return {
    at: pick.band.at,
    timeOfDay: pick.band.timeOfDay,
    // `filled` gates the pin offer. Only a preference-1 pick (an UNSERVED
    // slot whose suggestion window contains the take) is pinnable; the
    // nearest-anchor fallback is due-context only, so it reads filled even
    // when the slot itself is unserved — the pin never reaches across the
    // suggestion cap.
    filled: pick !== bestSuggest,
  };
}

/** The band whose anchor is within epsilon of `instant`, nearest wins. */
export function nearestAnchorBand(
  instant: Date,
  bands: SlotBand[],
): SlotBand | null {
  const t = instant.getTime();
  let best: SlotBand | null = null;
  let bestDist = Infinity;
  for (const band of bands) {
    const dist = Math.abs(band.at.getTime() - t);
    if (dist <= ANCHOR_EPSILON_MS && dist < bestDist) {
      bestDist = dist;
      best = band;
    }
  }
  return best;
}
