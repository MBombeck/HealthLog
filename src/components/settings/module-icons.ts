import type { LucideIcon } from "lucide-react";

import { DESTINATION_ICONS as ICON } from "@/components/layout/destination-icons";
import type { ModuleKey } from "@/lib/modules/registry";

/**
 * The glyph per toggleable module: the icon of the destination the module
 * opens, from the one map (`layout/destination-icons`), so a module row and its
 * rail entry show the same picture. `insights` is AI analysis, hence the AI
 * glyph rather than the Insights bulb.
 */
export const MODULE_ICONS: Record<ModuleKey, LucideIcon> = {
  cycle: ICON.cycle,
  mood: ICON.mood,
  sleep: ICON.sleep,
  glucose: ICON.glucose,
  workouts: ICON.workouts,
  recovery: ICON.recovery,
  labs: ICON.labs,
  illness: ICON.illness,
  achievements: ICON.achievements,
  coach: ICON.coach,
  insights: ICON.ai,
  medications: ICON.medications,
  doctorReport: ICON.doctorReport,
  environment: ICON.environment,
  mcp: ICON.mcp,
  inboundDocuments: ICON.documents,
  mentalHealth: ICON.mentalWellbeing,
  nutrients: ICON.nutrients,
  vaccinations: ICON.vaccinations,
  timeline: ICON.timeline,
  seizures: ICON.seizures,
};
