import { ADMIN_ICONS } from "./admin";
import { AREA_ICONS } from "./areas";
import { RAIL_ICONS } from "./rail";
import { SETTINGS_ICONS } from "./settings";

/**
 * One icon per destination, for every surface that names one.
 *
 * The rail, the collapsed rail, the phone's bottom bar and More sheet, the
 * account menus, the Settings and Admin rails, the module list and the search
 * palette all read their glyph from here, so the Coach cannot be a speech
 * bubble in the rail, a robot in Settings and a sparkle in Admin again, and a
 * glyph cannot stand for two places at once. `Sparkles` means AI and nothing
 * else.
 *
 * Two surfaces share a glyph only when they name the same destination id:
 * the person's About page and the server's, the person's API tokens and the
 * server-wide token list, the Coach and its Admin page. The guard is
 * `src/__tests__/destination-icon-guard.test.ts`.
 *
 * The map is split by surface into the files beside this one so the app
 * shell, which renders only the rail, does not carry the Settings and Admin
 * glyphs; this index is the one map every other caller and the guard read.
 */
export const DESTINATION_ICONS = {
  ...RAIL_ICONS,
  ...AREA_ICONS,
  ...SETTINGS_ICONS,
  ...ADMIN_ICONS,
} as const;

export type DestinationId = keyof typeof DESTINATION_ICONS;

export { ADMIN_ICONS, AREA_ICONS, RAIL_ICONS, SETTINGS_ICONS };
