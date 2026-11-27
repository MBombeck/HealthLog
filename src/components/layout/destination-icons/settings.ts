import {
  Blocks,
  Download,
  Gauge,
  Info,
  KeyRound,
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

/**
 * Rows of the Settings rail. Part of `DESTINATION_ICONS` (`./index.ts`).
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
  apiTokens: KeyRound,
  export: Download,
  privacy: Lock,
  advanced: Settings2,
  about: Info,
} as const satisfies Record<string, LucideIcon>;
