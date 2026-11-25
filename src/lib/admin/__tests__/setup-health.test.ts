import { afterEach, describe, expect, it, vi } from "vitest";

import en from "../../../../messages/en.json";
import { readSetupHealthInputs } from "../setup-health";
import {
  evaluateAppUrl,
  evaluateDatabaseDump,
  evaluateEncryptionKeys,
  evaluateSecureCookie,
  evaluateSetupHealth,
  type SetupHealthSignal,
} from "../setup-health-model";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Behind Apache: the container sees plain HTTP from a private peer. */
function behindApache(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3000/api/admin/setup-health", {
    headers: {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "health.example.org",
      "x-forwarded-for": "198.51.100.7",
      ...headers,
    },
  });
}

async function signalOf(request: Request, env: Record<string, string>) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SESSION_COOKIE_SECURE", "");
  const health = evaluateSetupHealth(await readSetupHealthInputs(request, env));
  return (id: string) => health.signals.find((s) => s.id === id)!;
}

describe("the setup check behind a TLS proxy", () => {
  it("does not call an HTTPS site behind Apache plain HTTP", async () => {
    const signal = await signalOf(behindApache(), {
      NEXT_PUBLIC_APP_URL: "https://health.example.org",
    });
    expect(signal("secure_cookie")).toMatchObject({
      state: "attention",
      reason: "proxy_scheme_unreported",
      docsUrl: "https://docs.healthlog.dev/guides/reverse-proxy/",
    });
    expect(signal("app_url")).toMatchObject({
      state: "ok",
      reason: "matches",
      params: { url: "https://health.example.org" },
    });
  });

  it("is all fine once the proxy sends X-Forwarded-Proto", async () => {
    const signal = await signalOf(
      behindApache({ "x-forwarded-proto": "https" }),
      {
        NEXT_PUBLIC_APP_URL: "https://health.example.org",
      },
    );
    expect(signal("secure_cookie")).toMatchObject({
      state: "ok",
      reason: "secure_over_https",
    });
    expect(signal("app_url").reason).toBe("matches");
  });

  it("never fails the cookie check it is read over", async () => {
    const signal = await signalOf(behindApache(), {});
    expect(signal("secure_cookie")).toMatchObject({
      state: "attention",
      reason: "secure_over_http",
    });
  });
});

describe("every reason the model gives has a sentence", () => {
  const reasons = en.admin.setupHealth.reason as Record<
    string,
    Record<string, string>
  >;
  const signals: SetupHealthSignal[] = [];
  for (const secure of [true, false]) {
    for (const protocol of ["https", "http", null] as const) {
      for (const from of ["proxy", "public_url", "request", null] as const) {
        signals.push(evaluateSecureCookie(secure, protocol, from));
      }
    }
  }
  signals.push(
    evaluateAppUrl(null, null),
    evaluateAppUrl("not a url", null),
    evaluateAppUrl("https://a.example", "https://b.example"),
    evaluateAppUrl("https://a.example", "https://a.example"),
    evaluateEncryptionKeys({ configuredKeys: 0, activeKeyId: null }),
    evaluateEncryptionKeys({ configuredKeys: 1, activeKeyId: "v1" }),
    evaluateDatabaseDump({ enabled: false, persistent: false, cron: "" }),
    evaluateDatabaseDump({ enabled: true, persistent: false, cron: "" }),
    evaluateDatabaseDump({
      enabled: true,
      persistent: true,
      cron: "0 3 * * *",
    }),
  );

  it.each(signals.map((s) => [`${s.id}.${s.reason}`, s]))("%s", (_, s) => {
    expect(reasons[s.id]?.[s.reason]).toEqual(expect.any(String));
  });
});
