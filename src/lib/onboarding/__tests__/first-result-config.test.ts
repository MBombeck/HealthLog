/**
 * v1.39 (C2) — every Q2 area and every connectable Q4 source has a target
 * on a surface that exists, so the first-result screen can never be handed
 * a task it cannot render.
 */
import { describe, expect, it } from "vitest";

import { ONBOARDING_AREA_KEYS } from "@/lib/modules/registry";
import { NAV_DESTINATIONS } from "@/components/layout/nav-model";

import {
  AREA_PAGE_HREF,
  AREA_READING_TARGETS,
  SOURCE_INTEGRATION,
} from "../first-result-config";
import { BROWSER_CONNECTABLE_SOURCES } from "../wizard-steps";

describe("first-result targets", () => {
  it("covers every area with exactly one of a form or a page", () => {
    for (const area of ONBOARDING_AREA_KEYS) {
      const hasForm = area in AREA_READING_TARGETS;
      const hasPage = area in AREA_PAGE_HREF;
      expect(hasForm !== hasPage, area).toBe(true);
    }
  });

  it("points every linked area at a destination the navigation knows", () => {
    const hrefs = new Set(NAV_DESTINATIONS.map((d) => d.href));
    for (const href of Object.values(AREA_PAGE_HREF)) {
      expect(hrefs.has(href), href).toBe(true);
    }
  });

  it("names an integration for every source the browser can connect", () => {
    for (const source of BROWSER_CONNECTABLE_SOURCES) {
      expect(SOURCE_INTEGRATION[source].anchor).toBeTruthy();
      expect(SOURCE_INTEGRATION[source].statusKey).toBeTruthy();
    }
  });
});
