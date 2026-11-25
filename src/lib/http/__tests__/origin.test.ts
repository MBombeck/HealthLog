import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { resolveOrigin, resolveRequestOrigin } from "../origin";
import {
  __uninstallPeerAddressStampForTests,
  FORWARDED_PROTO_SENT_HEADER,
  installPeerAddressStamp,
  PEER_ADDRESS_HEADER,
} from "../peer-address";

const PUBLIC = { NEXT_PUBLIC_APP_URL: "https://health.example.org" };

function req(headers: Record<string, string>, url = "http://app:3000/x") {
  return new Request(url, { headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The real pipe: a node server with the peer stamp installed and a handler
 * that fills the forwarding headers exactly as Next's base server does
 * (`req.headers['x-forwarded-proto'] ??= isHttps ? 'https' : 'http'`), then
 * hands the route a `Request`. An Apache `ProxyPass` sends `X-Forwarded-Host`
 * and `X-Forwarded-For` but no `X-Forwarded-Proto`.
 */
async function throughServer(
  sent: Record<string, string>,
  env: Record<string, string | undefined>,
) {
  installPeerAddressStamp();
  onTestFinished(__uninstallPeerAddressStampForTests);
  let resolved: ReturnType<typeof resolveRequestOrigin> | null = null;
  const server = createServer((incoming, res) => {
    incoming.headers["x-forwarded-host"] ??= incoming.headers.host;
    incoming.headers["x-forwarded-proto"] ??= "http";
    incoming.headers["x-forwarded-for"] ??= incoming.socket.remoteAddress;
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    resolved = resolveRequestOrigin(
      new Request(`http://localhost${incoming.url}`, { headers }),
      env,
    );
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await new Promise<void>((resolve, reject) => {
      const r = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/admin/setup-health",
          headers: sent,
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      r.on("error", reject);
      r.end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return resolved!;
}

describe("resolveRequestOrigin through a server that fills the headers", () => {
  it("reads an HTTPS site behind Apache as HTTPS from the public URL", async () => {
    const out = await throughServer(
      {
        host: "127.0.0.1:3000",
        "x-forwarded-host": "health.example.org",
        "x-forwarded-for": "198.51.100.7",
      },
      PUBLIC,
    );
    expect(out).toEqual({
      origin: "https://health.example.org",
      protocol: "https",
      host: "health.example.org",
      protocolFrom: "public_url",
    });
  });

  it("does not take the scheme Next filled in for the proxy's report", async () => {
    const out = await throughServer(
      { host: "127.0.0.1:3000", "x-forwarded-host": "health.example.org" },
      {},
    );
    expect(out.protocol).toBe("http");
    expect(out.protocolFrom).toBe("request");
  });

  it("believes a proxy that does send X-Forwarded-Proto", async () => {
    const out = await throughServer(
      {
        "x-forwarded-host": "health.example.org",
        "x-forwarded-proto": "https",
      },
      {},
    );
    expect(out.protocol).toBe("https");
    expect(out.protocolFrom).toBe("proxy");
  });

  it("keeps a proxy's explicit http over the public URL", async () => {
    const out = await throughServer(
      {
        "x-forwarded-host": "health.example.org",
        "x-forwarded-proto": "http",
      },
      PUBLIC,
    );
    expect(out.protocol).toBe("http");
    expect(out.protocolFrom).toBe("proxy");
  });

  it("overwrites a caller's own copy of the stamp", async () => {
    const out = await throughServer(
      {
        "x-forwarded-host": "health.example.org",
        [FORWARDED_PROTO_SENT_HEADER]: "https",
      },
      {},
    );
    expect(out.protocol).toBe("http");
  });
});

describe("resolveRequestOrigin from headers", () => {
  it("reads an RFC 7239 Forwarded header", () => {
    const out = resolveRequestOrigin(
      req({
        forwarded: 'for=198.51.100.7;proto=https;host="health.example.org"',
      }),
      {},
    );
    expect(out.origin).toBe("https://health.example.org");
    expect(out.protocolFrom).toBe("proxy");
  });

  it("reads X-Forwarded-Ssl: on", () => {
    const out = resolveRequestOrigin(req({ "x-forwarded-ssl": "on" }), {});
    expect(out.protocol).toBe("https");
  });

  it("reads the left-most entry of a proto chain", () => {
    const out = resolveRequestOrigin(
      req({ "x-forwarded-proto": "https, http" }),
      {},
    );
    expect(out.protocol).toBe("https");
  });

  it("falls back to APP_URL when NEXT_PUBLIC_APP_URL is unset", () => {
    const out = resolveRequestOrigin(
      req({ "x-forwarded-host": "health.example.org" }),
      { APP_URL: "https://health.example.org/" },
    );
    expect(out.protocol).toBe("https");
    expect(out.protocolFrom).toBe("public_url");
  });

  it("does not lend the public URL's scheme to another host", () => {
    const out = resolveRequestOrigin(
      req({ "x-forwarded-host": "other.example.org" }),
      PUBLIC,
    );
    expect(out.origin).toBe("http://other.example.org");
    expect(out.protocolFrom).toBe("request");
  });

  it("ignores forwarding headers from a peer that may not forward", () => {
    installPeerAddressStamp();
    onTestFinished(__uninstallPeerAddressStampForTests);
    const out = resolveRequestOrigin(
      req(
        {
          host: "app:3000",
          [PEER_ADDRESS_HEADER]: "203.0.113.9",
          [FORWARDED_PROTO_SENT_HEADER]: "https",
          "x-forwarded-host": "attacker.example",
          forwarded: "proto=https;host=attacker.example",
        },
        "http://app:3000/x",
      ),
      {},
    );
    expect(out.origin).toBe("http://app:3000");
  });

  it("honours TRUSTED_PROXY_CIDRS", () => {
    vi.stubEnv("TRUSTED_PROXY_CIDRS", "10.1.0.0/16");
    installPeerAddressStamp();
    onTestFinished(__uninstallPeerAddressStampForTests);
    const sent = {
      host: "app:3000",
      [FORWARDED_PROTO_SENT_HEADER]: "https",
      "x-forwarded-host": "health.example.org",
    };
    expect(
      resolveRequestOrigin(
        req({ ...sent, [PEER_ADDRESS_HEADER]: "10.1.2.3" }),
        {},
      ).origin,
    ).toBe("https://health.example.org");
    expect(
      resolveRequestOrigin(
        req({ ...sent, [PEER_ADDRESS_HEADER]: "172.18.0.1" }),
        {},
      ).origin,
    ).toBe("http://app:3000");
  });

  it("resolveOrigin is the resolved origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://health.example.org");
    expect(
      resolveOrigin(req({ "x-forwarded-host": "health.example.org" })),
    ).toBe("https://health.example.org");
  });
});
