/**
 * One destination, one icon; one icon, one destination.
 *
 * Every surface that names a destination (the rail and the phone's bars,
 * which render `NAV_DESTINATIONS`; the account menus; the Settings and Admin
 * rails; the module list; the search palette, which reads all of these)
 * declares here which destination each of its entries is. The entry's glyph
 * must be that destination's glyph from `DESTINATION_ICONS`, and no two
 * destinations may share one. An entry nobody declared fails too, so a new
 * row cannot ship with a glyph picked on the spot.
 *
 * Before this guard the Coach was a speech bubble in the rail, a robot in
 * Settings, a sparkle in Admin and a heart bubble in Modules, and the bell
 * stood for three different places.
 */
import { describe, expect, it } from "vitest";

import { ADMIN_SECTIONS } from "@/components/admin/admin-shell";
import {
  DESTINATION_ICONS,
  type DestinationId,
} from "@/components/layout/destination-icons";
import {
  NAV_ACCOUNT_MENU_DESTINATIONS,
  NAV_DESTINATIONS,
  NAV_UTILITY_DESTINATIONS,
} from "@/components/layout/nav-model";
import { MODULE_ICONS } from "@/components/settings/module-icons";
import { SETTINGS_SECTIONS } from "@/components/settings/settings-shell";
import type { ModuleKey } from "@/lib/modules/registry";

const NAV: Record<string, DestinationId> = {
  "/": "dashboard",
  "/measurements": "measurements",
  "/medications": "medications",
  "/mood": "mood",
  "/mental-wellbeing": "mentalWellbeing",
  "/cycle": "cycle",
  "/care": "care",
  "/labs": "labs",
  "/profile": "medicalHistory",
  "/illness": "illness",
  "/seizures": "seizures",
  "/vaccinations": "vaccinations",
  "/documents": "documents",
  "/timeline": "timeline",
  "/insights": "insights",
  "/coach": "coach",
  "/achievements": "achievements",
  "/emergency-card": "emergencyCard",
};

const UTILITY: Record<string, DestinationId> = {
  settings: "settings",
  notifications: "notifications",
};

const SETTINGS: Record<string, DestinationId> = {
  account: "account",
  security: "security",
  access: "access",
  modules: "modules",
  layout: "arrangement",
  notifications: "notifications",
  score: "healthScore",
  thresholds: "targets",
  anamnesis: "medicalHistory",
  environment: "environment",
  ai: "ai",
  coach: "coach",
  integrations: "integrations",
  sources: "sources",
  api: "apiTokens",
  mcp: "mcp",
  export: "export",
  "health-record": "doctorReport",
  privacy: "privacy",
  advanced: "advanced",
  about: "about",
};

const ADMIN: Record<string, DestinationId> = {
  "system-status": "systemStatus",
  general: "serverGeneral",
  "module-availability": "serverModules",
  about: "about",
  services: "pushChannels",
  reminders: "reminderChecks",
  coach: "coach",
  integrations: "monitoring",
  "api-tokens": "apiTokens",
  users: "users",
  invites: "invites",
  "login-overview": "loginOverview",
  "app-logs": "appLogs",
  backups: "backups",
  encryption: "encryption",
  "danger-zone": "dangerZone",
};

const MODULES: Record<ModuleKey, DestinationId> = {
  cycle: "cycle",
  mood: "mood",
  sleep: "sleep",
  glucose: "glucose",
  workouts: "workouts",
  recovery: "recovery",
  labs: "labs",
  illness: "illness",
  achievements: "achievements",
  coach: "coach",
  insights: "ai",
  medications: "medications",
  doctorReport: "doctorReport",
  environment: "environment",
  mcp: "mcp",
  inboundDocuments: "documents",
  mentalHealth: "mentalWellbeing",
  nutrients: "nutrients",
  vaccinations: "vaccinations",
  timeline: "timeline",
  seizures: "seizures",
};

type Row = { surface: string; key: string; icon: unknown };

const SURFACES: Array<{
  name: string;
  map: Record<string, DestinationId>;
  rows: Row[];
}> = [
  {
    name: "rail",
    map: NAV,
    rows: [...NAV_DESTINATIONS, ...NAV_ACCOUNT_MENU_DESTINATIONS].map((d) => ({
      surface: "rail",
      key: d.href,
      icon: d.icon,
    })),
  },
  {
    name: "account menu",
    map: UTILITY,
    rows: NAV_UTILITY_DESTINATIONS.map((d) => ({
      surface: "account menu",
      key: d.id,
      icon: d.icon,
    })),
  },
  {
    name: "settings",
    map: SETTINGS,
    rows: SETTINGS_SECTIONS.map((s) => ({
      surface: "settings",
      key: s.slug,
      icon: s.icon,
    })),
  },
  {
    name: "admin",
    map: ADMIN,
    rows: ADMIN_SECTIONS.map((s) => ({
      surface: "admin",
      key: s.slug,
      icon: s.icon,
    })),
  },
  {
    name: "modules",
    map: MODULES,
    rows: Object.entries(MODULE_ICONS).map(([key, icon]) => ({
      surface: "modules",
      key,
      icon,
    })),
  },
];

describe("one destination, one icon", () => {
  it.each(SURFACES.map((s) => [s.name, s] as const))(
    "%s: every entry shows its destination's icon",
    (_name, surface) => {
      expect(surface.rows.length).toBeGreaterThan(0);
      const wrong: string[] = [];
      for (const row of surface.rows) {
        const id = surface.map[row.key];
        if (id === undefined) {
          wrong.push(`${row.key}: no destination declared in this guard`);
          continue;
        }
        if (row.icon !== DESTINATION_ICONS[id]) {
          wrong.push(`${row.key}: not the icon of "${id}"`);
        }
      }
      expect(wrong).toEqual([]);
    },
  );

  it("declares no entry a surface does not have", () => {
    for (const surface of SURFACES) {
      const keys = new Set(surface.rows.map((r) => r.key));
      for (const key of Object.keys(surface.map)) {
        expect(keys.has(key), `${surface.name}: ${key}`).toBe(true);
      }
    }
  });

  it("gives no two destinations the same icon", () => {
    const byIcon = new Map<unknown, string[]>();
    for (const [id, icon] of Object.entries(DESTINATION_ICONS)) {
      byIcon.set(icon, [...(byIcon.get(icon) ?? []), id]);
    }
    const shared = [...byIcon.values()].filter((ids) => ids.length > 1);
    expect(shared).toEqual([]);
  });

  it("keeps the AI glyph for AI", () => {
    // Sparkles marks model work; a destination that is not AI must not
    // borrow it, and the AI settings row must keep it.
    expect(DESTINATION_ICONS.ai.displayName ?? "").toMatch(/Sparkles/);
  });
});
