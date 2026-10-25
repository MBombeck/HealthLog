import { request as httpRequest, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, onTestFinished } from "vitest";

import {
  __uninstallPeerAddressStampForTests,
  installPeerAddressStamp,
  PEER_ADDRESS_HEADER,
  readPeerAddress,
} from "../peer-address";

/**
 * The stamp is what the client-IP resolver trusts, so a caller must not be
 * able to set it: the server writes the socket's address over whatever the
 * request carried under that name.
 */
describe("installPeerAddressStamp", () => {
  it("writes the socket's address over a header the caller sent", async () => {
    installPeerAddressStamp();
    installPeerAddressStamp(); // once per process, however often it is called
    onTestFinished(__uninstallPeerAddressStampForTests);

    const seen: Array<string | string[] | undefined> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers[PEER_ADDRESS_HEADER]);
      res.end("ok");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/",
            headers: { [PEER_ADDRESS_HEADER]: "203.0.113.9" },
          },
          (res) => {
            res.resume();
            res.on("end", resolve);
          },
        );
        req.on("error", reject);
        req.end();
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(seen).toEqual(["127.0.0.1"]);
  });

  it("reads the stamp back, normalised", () => {
    const read = (value?: string) =>
      readPeerAddress(
        new Request("http://x/", {
          headers: value === undefined ? {} : { [PEER_ADDRESS_HEADER]: value },
        }),
      );
    expect(read()).toBeUndefined();
    expect(read("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(read("2001:db8::1")).toBe("2001:db8::1");
    expect(read("not-an-ip")).toBeNull();
  });
});
