/**
 * Regression test for the Coach learn catalog prompt block.
 *
 * Verifies that the prompt block does not contain standalone `/learn` tokens
 * (which trigger external assistant / ACP tool-injection blocks like `<LEARN>`),
 * while retaining all published guide URLs and guidance.
 */
import { describe, expect, it } from "vitest";

import {
  LEARN_GUIDES,
  learnCatalogPromptBlock,
} from "@/lib/ai/coach/learn-catalog";
import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";

describe("learnCatalogPromptBlock", () => {
  it("lacks standalone /learn tokens that could trigger ACP command injection", () => {
    const block = learnCatalogPromptBlock();

    // Standalone /learn token: /learn not immediately followed by /
    // e.g. "/learn " or "/learn\n" or "...never invent a /learn URL..."
    const standaloneLearnPattern = /(?:^|\s)\/learn(?=[^\w/]|$)/i;
    expect(block).not.toMatch(standaloneLearnPattern);

    // Specifically verify the reworded guidance phrasing
    expect(block).toContain("never invent a learn-guide URL or article");
    expect(block).not.toContain("never invent a /learn URL");

    // Every occurrence of "/learn" in the block must be part of a full URL path "/learn/"
    const matches = block.match(/\/learn[^\s]*/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match).toMatch(/^\/learn\/[a-z0-9-]+/);
    }
  });

  it("retains all published guide URLs in the prompt block", () => {
    const block = learnCatalogPromptBlock();

    expect(LEARN_GUIDES.length).toBeGreaterThanOrEqual(15);
    for (const guide of LEARN_GUIDES) {
      expect(block).toContain(guide.url);
      expect(guide.url).toMatch(/^https:\/\/healthlog\.dev\/learn\/[a-z0-9-]+$/);
    }
  });

  it("ensures the resolved Coach system prompt also lacks standalone /learn", () => {
    const systemPrompt = getCoachSystemPrompt("en");

    const standaloneLearnPattern = /(?:^|\s)\/learn(?=[^\w/]|$)/i;
    expect(systemPrompt).not.toMatch(standaloneLearnPattern);
    expect(systemPrompt).toContain("LEARN GUIDES");
    expect(systemPrompt).toContain("never invent a learn-guide URL or article");
  });
});
