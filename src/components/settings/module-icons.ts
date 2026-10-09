import {
  Activity,
  Award,
  Brain,
  CalendarHeart,
  CloudSun,
  Droplet,
  Dumbbell,
  FileScan,
  FileText,
  History,
  Leaf,
  MessageCircleHeart,
  Moon,
  Pill,
  Plug,
  Smile,
  Sparkles,
  Syringe,
  TestTube,
  Thermometer,
  type LucideIcon,
} from "lucide-react";

import type { ModuleKey } from "@/lib/modules/registry";

/** Neutral Lucide glyph per toggleable module. */
export const MODULE_ICONS: Record<ModuleKey, LucideIcon> = {
  cycle: CalendarHeart,
  mood: Smile,
  sleep: Moon,
  glucose: Droplet,
  workouts: Dumbbell,
  recovery: Activity,
  labs: TestTube,
  illness: Thermometer,
  achievements: Award,
  coach: MessageCircleHeart,
  insights: Sparkles,
  // v1.18.1 (D3) — medications graduated from CORE to a toggleable module.
  medications: Pill,
  doctorReport: FileText,
  // v1.25.0 — the environmental-context module (opt-in weather/daylight feed).
  environment: CloudSun,
  // v1.22.0 — the remote MCP endpoint (opt-in connectivity module).
  mcp: Plug,
  // v1.25.0 (W-DOCS-IN) — inbound clinical documents (opt-in).
  inboundDocuments: FileScan,
  // v1.25.0 — opt-in mental-health screeners (PHQ-9 / GAD-7).
  mentalHealth: Brain,
  // v1.28 — opt-in micronutrient-intake sync (Apple Health day totals).
  nutrients: Leaf,
  // v1.38.0 — the immunization log.
  vaccinations: Syringe,
  // v1.42 — the life timeline (opt-in).
  timeline: History,
};
