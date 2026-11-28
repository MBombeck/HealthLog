/**
 * Every source a SYNC_STALLED notice can name has one deep link, and it lands.
 *
 * The notice opens `/settings/integrations#<source>` (`stallTapUrl`). A push
 * straight to the device carries that path as `url`; a push over the relay
 * carries only the source key and the client builds the same path, as the
 * `notifications.sync-stalled` feature doc publishes. Three things can drift
 * apart without any other test noticing: the set of sources that can stall,
 * the anchor that opens a source's sheet on the integrations page, and the key
 * the iOS metadata filter lets through. A missing anchor would open the page
 * at its top; a key the filter drops would leave a relay push without a
 * source to build the link from.
 */
import { describe, expect, it } from "vitest";

import { pickIosMetadata } from "@/lib/notifications/senders/ios-metadata";
import { SERVER_FEATURE_DOCS } from "@/lib/server-features";
import { STALL_SOURCES, stallTapUrl } from "@/lib/sync-stall/quiet";

import { overviewKeyFromHash } from "@/components/settings/integrations/integration-registry";
import {
  OVERVIEW_SOURCE_KEYS,
  resolveSourceItem,
} from "@/lib/integrations/overview";

// Every source as the overview publishes it; the page opens the sheet of the
// key an anchor names, set up or not.
const ITEMS = OVERVIEW_SOURCE_KEYS.map((key) =>
  resolveSourceItem({
    key,
    connected: false,
    configured: false,
    health: null,
    offered: true,
  }),
);

describe("SYNC_STALLED deep links", () => {
  it("covers the sources that deliver on their own, not the on-demand ones", () => {
    expect([...STALL_SOURCES].sort()).toEqual([
      "apple-health",
      "garmin",
      "google-health",
      "health-connect-app",
      "nightscout",
      "oura",
      "polar",
      "whoop",
      "withings",
    ]);
  });

  it.each([...STALL_SOURCES])("%s opens its own sheet", (source) => {
    expect(stallTapUrl(source)).toBe(`/settings/integrations#${source}`);
    expect(
      overviewKeyFromHash(
        new URL(stallTapUrl(source), "https://x").hash,
        ITEMS,
      ),
      `#${source} opens no sheet on the integrations page`,
    ).toBe(source);
    expect(pickIosMetadata({ source, url: stallTapUrl(source) })).toMatchObject(
      { source },
    );
  });

  it("the published feature doc names the pattern and every source", () => {
    const doc = SERVER_FEATURE_DOCS["notifications.sync-stalled"];
    expect(doc).toContain("/settings/integrations#<source>");
    for (const source of STALL_SOURCES) expect(doc).toContain(source);
  });
});
