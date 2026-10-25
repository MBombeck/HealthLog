import { describe, expect, it } from "vitest";
import {
  isPublicIp,
  isPublicUrl,
  webPushSubscriptionSchema,
} from "../notifications";

const EMBEDDED_PRIVATE_IPV4_CASES = [
  ["IPv4-mapped mixed loopback", "::ffff:127.0.0.1"],
  ["IPv4-mapped compressed RFC1918", "::ffff:a00:1"],
  ["IPv4-compatible mixed loopback", "::127.0.0.1"],
  ["IPv4-compatible compressed metadata", "::a9fe:a9fe"],
  ["6to4 compressed RFC1918", "2002:a00:1::"],
  ["6to4 expanded metadata", "2002:a9fe:a9fe:0:0:0:0:1"],
  ["NAT64 WKP mixed RFC1918", "64:ff9b::192.168.1.1"],
  ["NAT64 WKP compressed RFC1918", "64:ff9b::c0a8:101"],
  ["RFC8215 local-use compressed RFC1918", "64:ff9b:1:ac10:0:1::"],
  ["RFC8215 local-use expanded RFC1918", "64:ff9b:1:c0a8:0:101:0:0"],
] as const;

const PUBLIC_ADDRESS_CASES = [
  ["public IPv4", "8.8.8.8"],
  ["public native IPv6", "2606:4700:4700::1111"],
  ["public IPv4-mapped IPv6", "::ffff:8.8.8.8"],
  ["public IPv4-compatible IPv6", "::808:808"],
  ["public 6to4 IPv6", "2002:808:808::"],
  ["public NAT64 WKP IPv6", "64:ff9b::808:808"],
  ["public RFC8215 local-use IPv6", "64:ff9b:1:808:0:808::"],
] as const;

function literalUrl(ip: string): string {
  return ip.includes(":") ? `https://[${ip}]/push` : `https://${ip}/push`;
}

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

describe("canonical IPv4-embedded IPv6 transition matrix (SEC-03)", () => {
  it.each(EMBEDDED_PRIVATE_IPV4_CASES)(
    "rejects %s at both literal URL and raw-IP boundaries",
    (_label, ip) => {
      expect.soft(isPublicIp(ip)).toBe(false);
      expect(isPublicUrl(literalUrl(ip))).toBe(false);
    },
  );

  it.each(PUBLIC_ADDRESS_CASES)(
    "preserves %s at both literal URL and raw-IP boundaries",
    (_label, ip) => {
      expect.soft(isPublicIp(ip)).toBe(true);
      expect(isPublicUrl(literalUrl(ip))).toBe(true);
    },
  );

  it.each(["not-an-ip", "2001:::1", "12345::1"])(
    "denies invalid raw IP syntax: %s",
    (ip) => {
      expect(isPublicIp(ip)).toBe(false);
    },
  );

  it.each(["::", "::1", "fe80::1", "fd12:3456::1"])(
    "continues denying ordinary IPv6 special-use address %s",
    (ip) => {
      expect.soft(isPublicIp(ip)).toBe(false);
      expect(isPublicUrl(literalUrl(ip))).toBe(false);
    },
  );
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

/**
 * Ranges the floor used to call public: benchmarking, IETF protocol
 * assignments, multicast, reserved and broadcast IPv4; site-local and
 * multicast IPv6; the IPv4-translated spelling of a private address; and a
 * denylisted name written fully qualified with a trailing dot.
 */
describe("isPublicIp / isPublicUrl — reserved ranges and spellings", () => {
  it("refuses the reserved IPv4 ranges", () => {
    for (const ip of [
      "198.18.0.1",
      "198.19.255.254",
      "192.0.0.1",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    for (const ip of ["198.17.0.1", "198.20.0.1", "192.0.1.1", "223.255.0.1"]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });

  it("refuses site-local, multicast and IPv4-translated IPv6", () => {
    for (const ip of [
      "fec0::1",
      "feff::1",
      "ff02::1",
      "::ffff:0:7f00:1",
      "::ffff:0:a9fe:a9fe",
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    expect(isPublicIp("::ffff:0:808:808")).toBe(true);
  });

  it("refuses a denylisted name written with a trailing dot", () => {
    for (const url of [
      "http://localhost./",
      "http://localhost../x",
      "http://metadata.google.internal./",
      "http://printer.local./",
      "http://127.0.0.1./",
      "http://[::ffff:0:7f00:1]/",
    ]) {
      expect(isPublicUrl(url), url).toBe(false);
    }
    expect(isPublicUrl("https://example.com./")).toBe(true);
  });
});
