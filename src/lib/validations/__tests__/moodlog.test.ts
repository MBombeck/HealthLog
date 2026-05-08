import { describe, expect, it } from "vitest";
import { moodLogCredentialsSchema } from "../moodlog";

describe("moodLogCredentialsSchema SSRF guard", () => {
  it("accepts a public moodLog URL", () => {
    const r = moodLogCredentialsSchema.safeParse({
      url: "https://moodlog.app",
      apiKey: "k".repeat(40),
    });
    expect(r.success).toBe(true);
  });

  it("rejects RFC1918 URLs", () => {
    for (const url of [
      "http://10.0.0.1",
      "http://192.168.1.1",
      "http://172.16.0.1",
      "http://127.0.0.1",
    ]) {
      const r = moodLogCredentialsSchema.safeParse({
        url,
        apiKey: "k".repeat(40),
      });
      expect(r.success, `expected reject for ${url}`).toBe(false);
    }
  });

  it("rejects link-local (cloud metadata) URLs", () => {
    const r = moodLogCredentialsSchema.safeParse({
      url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      apiKey: "k".repeat(40),
    });
    expect(r.success).toBe(false);
  });

  it("rejects localhost", () => {
    const r = moodLogCredentialsSchema.safeParse({
      url: "http://localhost:8080",
      apiKey: "k".repeat(40),
    });
    expect(r.success).toBe(false);
  });
});
