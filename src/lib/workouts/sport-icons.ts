import {
  Activity,
  Bike,
  Dumbbell,
  Footprints,
  HeartPulse,
  Mountain,
  PersonStanding,
  type LucideIcon,
} from "lucide-react";
import { ownValue } from "@/lib/own-key";

/**
 * Shared sport-type → icon map. Previously three private copies
 * (`workout-list.tsx`, `workout-detail.tsx`, `recent-workouts-tile.tsx`)
 * that had already drifted — `mixedCardio` rendered `Heart` in the list but
 * `HeartPulse` in the detail view and the dashboard tile, so the same
 * workout showed two different glyphs between the row and its detail page.
 * `HeartPulse` won as the shared value (two of three sites already agreed).
 */
export const SPORT_TYPE_ICON: Record<string, LucideIcon> = {
  walking: Footprints,
  running: PersonStanding,
  cycling: Bike,
  hiking: Mountain,
  swimming: Activity,
  rowing: Activity,
  elliptical: Activity,
  stairClimber: Activity,
  yoga: PersonStanding,
  mindAndBody: PersonStanding,
  strength: Dumbbell,
  hiit: Activity,
  dance: Activity,
  golf: Activity,
  badminton: Activity,
  tennis: Activity,
  basketball: Activity,
  soccer: Activity,
  crossTraining: Activity,
  mixedCardio: HeartPulse,
  other: Activity,
};

export function iconForSport(sportType: string): LucideIcon {
  return ownValue(SPORT_TYPE_ICON, sportType) ?? Activity;
}
