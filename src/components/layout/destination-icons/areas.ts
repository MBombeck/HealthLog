import {
  BatteryCharging,
  CloudSun,
  Dumbbell,
  FileHeart,
  Leaf,
  Moon,
  Pipette,
  Plug,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

/**
 * Areas without a rail entry of their own (module rows, Settings rows that
 * name them). Part of `DESTINATION_ICONS` (`./index.ts`).
 */
export const AREA_ICONS = {
  ai: Sparkles,
  sleep: Moon,
  glucose: Pipette,
  workouts: Dumbbell,
  recovery: BatteryCharging,
  nutrients: Leaf,
  environment: CloudSun,
  mcp: Plug,
  doctorReport: FileHeart,
} as const satisfies Record<string, LucideIcon>;
