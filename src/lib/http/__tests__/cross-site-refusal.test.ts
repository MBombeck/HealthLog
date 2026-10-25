import { afterEach, describe, expect, it } from "vitest";

import { crossSiteWriteReason } from "../cross-site-guard";

const ORIGINAL_APP_URL = process.env.APP_URL;
afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
});

function req(
  headers: Record<string, string>,
  method = "POST",
  url = "http://app:3000/api/x",
) {
  return new Request(url, { method, headers });
}

describe("crossSiteWriteReason", () => {
  it("accepts the public origin behind a proxy that rewrites Host", () => {
    process.env.APP_URL = "https://health.example.com";
    expect(
      crossSiteWriteReason(
        req({ host: "app:3000", origin: "https://health.example.com" }),
        "/api/x",
      ),
    ).toBeNull();
    expect(
      crossSiteWriteReason(
        req({
          host: "app:3000",
          "x-forwarded-host": "lan.example.com",
          origin: "https://lan.example.com",
        }),
        "/api/x",
      ),
    ).toBeNull();
  });

  it("accepts a LAN install reached by its address over plain HTTP", () => {
    delete process.env.APP_URL;
    expect(
      crossSiteWriteReason(
        req({ host: "192.168.1.20:3000", origin: "http://192.168.1.20:3000" }),
        "/api/x",
      ),
    ).toBeNull();
  });

  it("refuses same-site and cross-site fetch metadata on every write method", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        crossSiteWriteReason(
          req({ "sec-fetch-site": "same-site" }, method),
          "/api/x",
        ),
      ).toBe("sec-fetch-site");
    }
  });

  it("leaves the webhook and URL-credential surfaces to their own secret", () => {
    for (const path of [
      "/api/withings/webhook/abc",
      "/api/whoop/webhook/abc",
      "/api/telegram/webhook",
      "/api/internal/deploy-webhook",
      "/api/notifications/action/hla_x",
      "/api/monitoring/csp-report",
    ]) {
      expect(
        crossSiteWriteReason(req({ "sec-fetch-site": "cross-site" }), path),
      ).toBeNull();
    }
  });
});
