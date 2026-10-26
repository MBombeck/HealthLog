import { describe, it, expect } from "vitest";

import {
  supportsVisionForConfig,
  supportsPdfForProvider,
} from "../vision-capability";

const GPT6_SLUGS = [
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6",
] as const;

describe("supportsVisionForConfig", () => {
  it("accepts the Claude 3 / 3.5 / 3.7 / 4 families for anthropic", () => {
    for (const model of [
      "claude-3-opus-20240229",
      "claude-3-sonnet-20240229",
      "claude-3-haiku-20240307",
      "claude-3-5-sonnet-latest",
      "claude-3-7-sonnet",
      "claude-sonnet-4-6",
      "claude-opus-4-1",
      "claude-haiku-4",
    ]) {
      expect(supportsVisionForConfig("anthropic", model)).toBe(true);
    }
  });

  it("accepts current Claude 5-generation and Fable pins for anthropic", () => {
    for (const model of [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5",
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-opus-4-8",
    ]) {
      expect(supportsVisionForConfig("anthropic", model)).toBe(true);
    }
  });

  it("rejects legacy / text-only anthropic models", () => {
    expect(supportsVisionForConfig("anthropic", "claude-2.1")).toBe(false);
    expect(supportsVisionForConfig("anthropic", "claude-instant-1")).toBe(
      false,
    );
    expect(supportsVisionForConfig("anthropic", null)).toBe(false);
  });

  it("accepts gpt-4o/4.1/turbo/o-series for openai + admin variants", () => {
    for (const providerType of [
      "openai",
      "admin-openai",
      "admin-key",
    ] as const) {
      expect(supportsVisionForConfig(providerType, "gpt-4o")).toBe(true);
      expect(supportsVisionForConfig(providerType, "gpt-4o-mini")).toBe(true);
      expect(supportsVisionForConfig(providerType, "gpt-5.6-terra")).toBe(true);
      expect(supportsVisionForConfig(providerType, "gpt-4.1")).toBe(true);
      expect(supportsVisionForConfig(providerType, "gpt-4-turbo")).toBe(true);
      // Full o-series reasoning models read images.
      expect(supportsVisionForConfig(providerType, "o1")).toBe(true);
      expect(supportsVisionForConfig(providerType, "o3")).toBe(true);
      expect(supportsVisionForConfig(providerType, "o4")).toBe(true);
    }
  });

  it("accepts the gpt-6 line for openai + admin variants", () => {
    // Every gpt-6 slug in the upstream catalog lists `input_modalities:
    // ["text", "image"]` (codex-rs/models-manager/models.json).
    for (const providerType of [
      "openai",
      "admin-openai",
      "admin-key",
    ] as const) {
      for (const model of GPT6_SLUGS) {
        expect(supportsVisionForConfig(providerType, model), model).toBe(true);
      }
    }
  });

  it("rejects non-vision openai models", () => {
    expect(supportsVisionForConfig("openai", "gpt-3.5-turbo")).toBe(false);
    expect(supportsVisionForConfig("openai", "gpt-4")).toBe(false);
    expect(supportsVisionForConfig("openai", null)).toBe(false);
  });

  it("rejects text-only o-series variants (-mini / -preview) for openai", () => {
    // o1-mini / o1-preview / o3-mini accept the `o*` prefix but have no image
    // input — claiming vision here 400s the user at the image block.
    for (const providerType of [
      "openai",
      "admin-openai",
      "admin-key",
    ] as const) {
      expect(supportsVisionForConfig(providerType, "o1-mini")).toBe(false);
      expect(supportsVisionForConfig(providerType, "o1-preview")).toBe(false);
      expect(supportsVisionForConfig(providerType, "o3-mini")).toBe(false);
    }
  });

  it("trusts local (operator opted in) regardless of model string", () => {
    expect(supportsVisionForConfig("local", "llava")).toBe(true);
    expect(supportsVisionForConfig("local", null)).toBe(true);
  });

  it("reports vision for codex on multimodal slugs, including -codex", () => {
    for (const model of [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-4o",
      "gpt-4.1",
      "o1",
      // The GPT-5.x `-codex` specialists are vision-capable: the wire reads
      // an `input_image` block on these slugs (docs/codex-protocol-spec.md +
      // OpenAI's current model lineup). The old "-codex is text-only"
      // exclusion was stale.
      "gpt-5-codex",
      "gpt-5.3-codex",
      "gpt-5.1-codex-mini",
    ]) {
      expect(supportsVisionForConfig("codex", model)).toBe(true);
    }
    // Non-multimodal / unknown slugs and a missing slug → false.
    expect(supportsVisionForConfig("codex", "gpt-4")).toBe(false);
    expect(supportsVisionForConfig("codex", "gpt-3.5-turbo")).toBe(false);
    expect(supportsVisionForConfig("codex", null)).toBe(false);
    // Text-only o-series variants are excluded for codex too.
    expect(supportsVisionForConfig("codex", "o1-mini")).toBe(false);
    expect(supportsVisionForConfig("codex", "o3-mini")).toBe(false);
    expect(supportsVisionForConfig("codex", "o1-preview")).toBe(false);
    // Full o-series stays vision-capable.
    expect(supportsVisionForConfig("codex", "o3")).toBe(true);
  });

  it("reports vision for codex and admin-codex on the gpt-6 line", () => {
    for (const providerType of ["codex", "admin-codex"] as const) {
      for (const model of GPT6_SLUGS) {
        expect(supportsVisionForConfig(providerType, model), model).toBe(true);
      }
    }
  });

  it("mirrors codex vision capability for the shared central codex (admin-codex)", () => {
    // The operator-shared central Codex runs the same wire on the same resolved
    // slug, so its vision gate is identical to `codex`.
    expect(supportsVisionForConfig("admin-codex", "gpt-5.5")).toBe(true);
    expect(supportsVisionForConfig("admin-codex", "gpt-5.3-codex")).toBe(true);
    expect(supportsVisionForConfig("admin-codex", "gpt-4")).toBe(false);
    expect(supportsVisionForConfig("admin-codex", "o3-mini")).toBe(false);
    expect(supportsVisionForConfig("admin-codex", null)).toBe(false);
  });

  it("never reports vision for none", () => {
    expect(supportsVisionForConfig("none", "gpt-4o")).toBe(false);
  });
});

describe("supportsPdfForProvider", () => {
  it("only anthropic supports native PDF", () => {
    expect(supportsPdfForProvider("anthropic")).toBe(true);
    expect(supportsPdfForProvider("openai")).toBe(false);
    expect(supportsPdfForProvider("admin-openai")).toBe(false);
    expect(supportsPdfForProvider("local")).toBe(false);
    expect(supportsPdfForProvider("codex")).toBe(false);
  });
});
