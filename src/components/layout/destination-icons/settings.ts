import {
  Blocks,
  Download,
  Gauge,
  Layers,
  Link2,
  Lock,
  Palette,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  User,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

import { SHARED_ICONS } from "./shared";

/**
 * Rows of the Settings rail. Part of `DESTINATION_ICONS` (`./index.ts`);
 * the two it shares with the Admin rail come from `./shared.ts`.
 */
export const SETTINGS_ICONS = {
  account: User,
  security: ShieldCheck,
  access: UsersRound,
  modules: Blocks,
  arrangement: Palette,
  healthScore: Gauge,
  targets: SlidersHorizontal,
  integrations: Link2,
  sources: Layers,
  export: Download,
  privacy: Lock,
  advanced: Settings2,
  ...SHARED_ICONS,
} as const satisfies Record<string, LucideIcon>;
