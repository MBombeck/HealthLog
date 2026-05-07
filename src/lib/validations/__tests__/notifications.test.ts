import { describe, expect, it } from "vitest";
import { isPublicUrl, webPushSubscriptionSchema } from "../notifications";

describe("isPublicUrl SSRF guard", () => {
  describe("allows public addresses", () => {
    it("real public hostnames", () => {
      expect(isPublicUrl("https://api.openai.com/v1")).toBe(true);
      expect(isPublicUrl("https://wbsapi.withings.net/v2/oauth2")).toBe(true);
      expect(isPublicUrl("http://example.com")).toBe(true);
    });

    it("does not block DNS labels that happen to start with 'fc'/'fd' (V3 audit regression)", () => {
      // The IPv6 unique-local-address check is gated on a colon. A domain
      // like fcm.googleapis.com or fd-cdn.example.com previously matched
      // `startsWith("fc"/"fd")` and was rejected. Pin the contract.
      expect(isPublicUrl("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
      expect(isPublicUrl("https://fd-cdn.example.com")).toBe(true);
      expect(isPublicUrl("https://fc.example.com")).toBe(true);
    });

    it("still blocks real IPv6 unique-local addresses (must contain colon)", () => {
      expect(isPublicUrl("http://[fc00::1]")).toBe(false);
      expect(isPublicUrl("http://[fd12:3456::1]")).toBe(false);
    });

    it("public IPv4 addresses", () => {
      expect(isPublicUrl("https://1.1.1.1")).toBe(true);
      expect(isPublicUrl("https://8.8.8.8")).toBe(true);
      expect(isPublicUrl("https://93.184.216.34")).toBe(true); // example.com
    });
  });

  describe("blocks loopback and link-local", () => {
    it("textual loopback hosts", () => {
      expect(isPublicUrl("http://localhost")).toBe(false);
      expect(isPublicUrl("http://localhost:8080")).toBe(false);
      expect(isPublicUrl("http://thing.localhost")).toBe(false);
      expect(isPublicUrl("https://service.internal")).toBe(false);
      expect(isPublicUrl("https://router.local")).toBe(false);
    });

    it("IPv4 loopback / 0.0.0.0", () => {
      expect(isPublicUrl("http://127.0.0.1")).toBe(false);
      expect(isPublicUrl("http://127.255.255.254")).toBe(false);
      expect(isPublicUrl("http://0.0.0.0")).toBe(false);
    });

    it("AWS metadata service + link-local 169.254/16", () => {
      expect(isPublicUrl("http://169.254.169.254/latest/meta-data/")).toBe(
        false,
      );
      expect(isPublicUrl("http://169.254.0.1")).toBe(false);
    });

    it("IPv6 loopback / unspecified / link-local / unique-local", () => {
      expect(isPublicUrl("http://[::1]")).toBe(false);
      expect(isPublicUrl("http://[::]")).toBe(false);
      expect(isPublicUrl("http://[fe80::1]")).toBe(false);
      expect(isPublicUrl("http://[fc00::1]")).toBe(false);
      expect(isPublicUrl("http://[fd12:3456::1]")).toBe(false);
    });

    it("IPv4-mapped IPv6 (::ffff:...) embedding private IPv4", () => {
      // Both notations parsers might emit:
      expect(isPublicUrl("http://[::ffff:127.0.0.1]")).toBe(false);
      expect(isPublicUrl("http://[::ffff:10.0.0.1]")).toBe(false);
      expect(isPublicUrl("http://[::ffff:192.168.1.1]")).toBe(false);
      expect(isPublicUrl("http://[::ffff:7f00:1]")).toBe(false); // hex form of 127.0.0.1
      expect(isPublicUrl("http://[::ffff:c0a8:0101]")).toBe(false); // hex form of 192.168.1.1
    });
  });

  describe("blocks RFC1918 + CGNAT", () => {
    it("10.0.0.0/8", () => {
      expect(isPublicUrl("http://10.0.0.1")).toBe(false);
      expect(isPublicUrl("http://10.255.255.254")).toBe(false);
    });

    it("172.16.0.0/12", () => {
      expect(isPublicUrl("http://172.16.0.1")).toBe(false);
      expect(isPublicUrl("http://172.31.255.254")).toBe(false);
      // 172.32 is outside the /12 — should still be public
      expect(isPublicUrl("http://172.32.0.1")).toBe(true);
    });

    it("192.168.0.0/16", () => {
      expect(isPublicUrl("http://192.168.1.1")).toBe(false);
      expect(isPublicUrl("http://192.168.255.254")).toBe(false);
    });

    it("100.64.0.0/10 (CGNAT)", () => {
      expect(isPublicUrl("http://100.64.0.1")).toBe(false);
      expect(isPublicUrl("http://100.127.255.254")).toBe(false);
      // 100.63 is below the range — public
      expect(isPublicUrl("http://100.63.0.1")).toBe(true);
    });
  });

  describe("regression: leading-zero IPv4 cannot bypass private checks", () => {
    // The old implementation used `h.startsWith("10.")` which treats
    // "010.0.0.1" as not-starting-with-"10." and waved it through.
    // The strict parser rejects octets with leading zeros entirely.
    it("rejects '010.0.0.1' (was a bypass)", () => {
      expect(isPublicUrl("http://010.0.0.1")).toBe(false);
    });

    it("rejects '0192.168.1.1'", () => {
      expect(isPublicUrl("http://0192.168.1.1")).toBe(false);
    });

    it("rejects '0010.10.10.10'", () => {
      expect(isPublicUrl("http://0010.10.10.10")).toBe(false);
    });

    it("rejects out-of-range octets — better safe than sorry", () => {
      // 256.0.0.1 looks like an IPv4 quad but is not valid. Rather than
      // falling through to "public" we deny — refusing a malformed URL is
      // better than risking misinterpretation as an internal address.
      expect(isPublicUrl("http://256.0.0.1")).toBe(false);
    });
  });

  describe("regression: alternate IPv4 notations cannot bypass private checks", () => {
    it("hex IPv4 (0x7f.0.0.1 = 127.0.0.1)", () => {
      expect(isPublicUrl("http://0x7f.0.0.1")).toBe(false);
      expect(isPublicUrl("http://0x7f000001")).toBe(false);
      expect(isPublicUrl("http://0xa.0.0.1")).toBe(false); // 10.0.0.1
    });

    it("decimal IPv4 (2130706433 = 127.0.0.1)", () => {
      expect(isPublicUrl("http://2130706433")).toBe(false);
      expect(isPublicUrl("http://167772161")).toBe(false); // 10.0.0.1
      expect(isPublicUrl("http://3232235777")).toBe(false); // 192.168.1.1
    });
  });

  describe("rejects bad protocols", () => {
    it("file://, ftp://, javascript:", () => {
      expect(isPublicUrl("file:///etc/passwd")).toBe(false);
      expect(isPublicUrl("ftp://example.com")).toBe(false);
      expect(isPublicUrl("javascript:alert(1)")).toBe(false);
    });

    it("invalid URLs", () => {
      expect(isPublicUrl("not a url")).toBe(false);
      expect(isPublicUrl("")).toBe(false);
    });
  });
});

// V3 audit: webPushSubscriptionSchema previously accepted any URL,
// allowing an authenticated user to point Push delivery at a private
// network (RFC1918 / link-local / loopback) → blind SSRF probe.
describe("webPushSubscriptionSchema SSRF guard (V3 audit)", () => {
  const keys = { p256dh: "abc", auth: "def" };

  it("accepts a real public HTTPS endpoint", () => {
    const r = webPushSubscriptionSchema.safeParse({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys,
    });
    expect(r.success).toBe(true);
  });

  it("rejects an HTTP endpoint", () => {
    const r = webPushSubscriptionSchema.safeParse({
      endpoint: "http://fcm.googleapis.com/fcm/send/abc",
      keys,
    });
    expect(r.success).toBe(false);
  });

  it("rejects an internal RFC1918 endpoint over https", () => {
    const r = webPushSubscriptionSchema.safeParse({
      endpoint: "https://10.0.0.1/push",
      keys,
    });
    expect(r.success).toBe(false);
  });

  it("rejects loopback https endpoint", () => {
    const r = webPushSubscriptionSchema.safeParse({
      endpoint: "https://127.0.0.1/push",
      keys,
    });
    expect(r.success).toBe(false);
  });

  it("rejects AWS metadata service link-local", () => {
    const r = webPushSubscriptionSchema.safeParse({
      endpoint: "https://169.254.169.254/latest/meta-data/",
      keys,
    });
    expect(r.success).toBe(false);
  });
});
