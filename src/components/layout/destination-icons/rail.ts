import {
  Activity,
  Bell,
  Brain,
  BrainCircuit,
  ClipboardList,
  Droplets,
  FileScan,
  FlaskConical,
  HeartPulse,
  History,
  Home,
  Lightbulb,
  MessagesSquare,
  Pill,
  Settings,
  Stethoscope,
  Syringe,
  Thermometer,
  Trophy,
  Waves,
  type LucideIcon,
} from "lucide-react";

/**
 * The rail, the phone's bars and the account menus. The app shell imports only
 * this file, so the Settings and Admin glyphs stay out of every page's first
 * load. Part of `DESTINATION_ICONS` (`./index.ts`).
 */
export const RAIL_ICONS = {
  // ── Rail ──
  dashboard: Home,
  measurements: Activity,
  medications: Pill,
  mood: Waves,
  mentalWellbeing: Brain,
  cycle: Droplets,
  care: Stethoscope,
  labs: FlaskConical,
  medicalHistory: ClipboardList,
  illness: Thermometer,
  seizures: BrainCircuit,
  vaccinations: Syringe,
  documents: FileScan,
  timeline: History,
  insights: Lightbulb,
  coach: MessagesSquare,
  achievements: Trophy,
  // ── Account menu ──
  settings: Settings,
  notifications: Bell,
  emergencyCard: HeartPulse,
} as const satisfies Record<string, LucideIcon>;
