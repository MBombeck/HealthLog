import { describe, expect, it } from "vitest";

import { looksSecretShaped } from "@/lib/secret-shape";

describe("looksSecretShaped", () => {
  it.each([
    ["an access token", "token hlk_abc123"],
    ["a refresh token", "hlr_xyz789"],
    ["a share-link token", "see hls_def456"],
    ["an invite token", "hlv_0a1b2c3d"],
    ["a managed-profile handover token", "hlp_0a1b2c3d"],
    ["an elevation token", "hle_0a1b2c3d"],
    ["a native sign-in handoff code", "hlh_Ab9-xYz_12"],
    ["an MCP authorization code", "hlac_eyJ0eXAi"],
    ["an MCP refresh token", "hlrt_eyJ0eXAi"],
    ["an MCP client id", "hlc_eyJ0eXAi"],
    ["an OpenAI key", "echoed sk-1234567890"],
    ["an Anthropic key", "sk-ant-api03-xyz12345"],
  ])("matches %s", (_label, text) => {
    expect(looksSecretShaped(text)).toBe(true);
  });

  it.each([
    ["a word containing sk-", "task-id must not contain spaces"],
    ["another one", "risk-management"],
    ["a JSON error body", '{"error":"Bad Request","errorCode":400}'],
  ])("does not match %s", (_label, text) => {
    expect(looksSecretShaped(text)).toBe(false);
  });
});
