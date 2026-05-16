import { permanentRedirect } from "next/navigation";

/**
 * v1.4.34 IW-D — `/settings/sources` permanent redirect.
 *
 * The Sources settings section was merged into `/settings/thresholds`
 * (now titled "Targets & Sources" / "Zielwerte & Quellen"). The two
 * editors share the same per-metric configuration shelf and reading
 * them side-by-side on one page matches how a user actually thinks
 * about metric configuration ("for this metric, which sources do I
 * trust AND what range counts as healthy?"). Per
 * `.planning/research/v1434-r-2-carryover-scope.md` §7 and
 * `.planning/round-v1433-audit-menu.md` §7.1 (item 3).
 *
 * 308 (`permanentRedirect`) keeps the request method intact so any
 * external system that POSTs (none today, but cheap insurance) follows
 * through with its original method. Existing bookmarks, iOS Settings
 * deep-links, and any docs that referenced `/settings/sources`
 * continue to resolve.
 */
export default function SettingsSourcesRedirect(): never {
  permanentRedirect("/settings/thresholds");
}
