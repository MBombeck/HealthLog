import { describe, expect, it } from "vitest";
import { isPublicUrl } from "../notifications";

describe("isPublicUrl SSRF guard", () => {
  describe("allows public addresses", () => {
    it("real public hostnames", () => {
      expect(isPublicUrl("https://api.openai.com/v1")).toBe(true);
      expect(isPublicUrl("https://wbsapi.withings.net/v2/oauth2")).toBe(true);
      expect(isPublicUrl("http://example.com")).toBe(true);
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

    it("IPv6 loopback and link-local", () => {
      expect(isPublicUrl("http://[::1]")).toBe(false);
      expect(isPublicUrl("http://[fe80::1]")).toBe(false);
      expect(isPublicUrl("http://[fc00::1]")).toBe(false);
      expect(isPublicUrl("http://[fd12:3456::1]")).toBe(false);
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
