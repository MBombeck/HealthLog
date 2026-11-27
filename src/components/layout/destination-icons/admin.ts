import {
  AlarmClock,
  Database,
  FileText,
  KeySquare,
  LayoutDashboard,
  Radar,
  Radio,
  ScrollText,
  Server,
  ShieldAlert,
  Ticket,
  ToggleRight,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * Rows of the Admin console's rail. Part of `DESTINATION_ICONS`
 * (`./index.ts`).
 */
export const ADMIN_ICONS = {
  adminOverview: LayoutDashboard,
  systemStatus: Server,
  serverGeneral: Wrench,
  serverModules: ToggleRight,
  pushChannels: Radio,
  reminderChecks: AlarmClock,
  monitoring: Radar,
  users: Users,
  invites: Ticket,
  loginOverview: ScrollText,
  appLogs: FileText,
  backups: Database,
  encryption: KeySquare,
  dangerZone: ShieldAlert,
} as const satisfies Record<string, LucideIcon>;
