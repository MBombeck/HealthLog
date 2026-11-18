/**
 * Regression test for the Coach learn catalog prompt block.
 *
 * Verifies that the ACP text emitted by buildPromptBlocks does not contain
 * `/learn` tokens (which trigger external assistant / ACP command injection
 * blocks like `<LEARN>`), including tokens directly following punctuation
 * (e.g. Polish./learn), while preserving all published safe guide URLs.
 */
import { describe, expect, it } from "vitest";

import {
  LEARN_GUIDES,
  learnCatalogPromptBlock,
} from "@/lib/ai/coach/learn-catalog";
import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";
import { buildPromptBlocks } from "@/lib/ai/antigravity-client";

describe("learnCatalogPromptBlock and ACP text", () => {
  // Matches any /learn not followed by a valid guide slug path (e.g. "/learn/slug").
  // Catches standalone "/learn", "...never invent a /learn URL...", and "Polish./learn",
  // without relying on whitespace boundaries, while preserving safe full URLs.
  const unsafeLearnPattern = /\/learn(?!\/[a-z0-9-]+)/i;

  it("the test pattern correctly catches /learn including Polish./learn while allowing safe URLs", () => {
    expect(unsafeLearnPattern.test("Polish./learn")).toBe(true);
    expect(unsafeLearnPattern.test("never invent a /learn URL")).toBe(true);
    expect(unsafeLearnPattern.test("/learn ")).toBe(true);
    expect(unsafeLearnPattern.test("in Polish./learn")).toBe(true);
    expect(
      unsafeLearnPattern.test("https://healthlog.dev/learn/resting-heart-rate"),
    ).toBe(false);
  });

  it("ensures actual ACP prompt blocks from buildPromptBlocks contain no unsafe /learn tokens", () => {
    const systemPrompt = getCoachSystemPrompt("en");
    expect(systemPrompt).not.toMatch(unsafeLearnPattern);

    const blocks = buildPromptBlocks({
      messages: [{ role: "user", content: "hi" }],
      system: systemPrompt,
    });

    const acpText = blocks
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n\n");

    expect(acpText).not.toMatch(unsafeLearnPattern);
    expect(acpText).toContain("never invent a learn-guide URL or article");
    expect(acpText).not.toContain("never invent a /learn URL");

    // All safe guide URLs must be preserved in the prompt
    for (const guide of LEARN_GUIDES) {
      expect(acpText).toContain(guide.url);
      expect(guide.url).toMatch(
        /^https:\/\/healthlog\.dev\/learn\/[a-z0-9-]+$/,
      );
    }
  });

  it("learnCatalogPromptBlock lacks unsafe /learn tokens and retains all published guides", () => {
    const block = learnCatalogPromptBlock();

    expect(block).not.toMatch(unsafeLearnPattern);
    expect(block).toContain("never invent a learn-guide URL or article");
    expect(block).not.toContain("never invent a /learn URL");

    expect(LEARN_GUIDES.length).toBeGreaterThanOrEqual(15);
    for (const guide of LEARN_GUIDES) {
      expect(block).toContain(guide.url);
    }
  });
});
