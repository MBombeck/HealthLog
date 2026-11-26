/**
 * The shared resolver every worded API route asks for its language.
 *
 * An app request says which language the app runs in through
 * `Accept-Language` and carries no locale cookie. Most routes resolve without
 * handing their request over, so the resolver reads the ambient request's
 * headers: a Bearer request is worded in the header's language, and an
 * account with no stored language never falls to English while the request
 * or the operator names another.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  headers: new Headers(),
  cookies: new Map<string, string>(),
  operatorDefault: null as string | null,
  outsideRequest: false,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => {
    if (state.outsideRequest) throw new Error("outside a request scope");
    return state.headers;
  }),
  cookies: vi.fn(async () => {
    if (state.outsideRequest) throw new Error("outside a request scope");
    return {
      get: (name: string) => {
        const value = state.cookies.get(name);
        return value ? { name, value } : undefined;
      },
    };
  }),
}));

vi.mock("@/lib/app-settings", () => ({
  getOperatorDefaultLocale: vi.fn(async () => state.operatorDefault),
}));

import { resolveServerLocale } from "../server-locale";

function request(init: Record<string, string>) {
  state.headers = new Headers(init);
}

beforeEach(() => {
  state.headers = new Headers();
  state.cookies.clear();
  state.operatorDefault = null;
  state.outsideRequest = false;
});

describe("resolveServerLocale", () => {
  it("words a Bearer request in the app's language over the stored one", async () => {
    request({ authorization: "Bearer hlk_x", "accept-language": "de-DE" });
    expect(await resolveServerLocale({ userLocale: "en" })).toBe("de");
    expect(await resolveServerLocale({ userLocale: null })).toBe("de");
  });

  it("reads the ambient request when the route passes none", async () => {
    request({ authorization: "Bearer hlk_x", "accept-language": "nl-BE" });
    expect(await resolveServerLocale()).toBe("nl");
  });

  it("keeps the stored language when a Bearer header names none we ship", async () => {
    request({ authorization: "Bearer hlk_x", "accept-language": "ja-JP" });
    expect(await resolveServerLocale({ userLocale: "de" })).toBe("de");
  });

  it("lets an explicit override win over everything", async () => {
    request({ authorization: "Bearer hlk_x", "accept-language": "de-DE" });
    expect(
      await resolveServerLocale({ override: "es", userLocale: "en" }),
    ).toBe("es");
  });

  it("keeps a browser on its cookie, then its stored language", async () => {
    request({ "accept-language": "de-DE" });
    state.cookies.set("healthlog-locale", "en");
    expect(await resolveServerLocale({ userLocale: "nl" })).toBe("en");
    state.cookies.clear();
    expect(await resolveServerLocale({ userLocale: "nl" })).toBe("nl");
  });

  it("falls to the header, then the operator default, never English by accident", async () => {
    request({ "accept-language": "de-DE" });
    expect(await resolveServerLocale({ userLocale: null })).toBe("de");
    request({});
    state.operatorDefault = "de";
    expect(await resolveServerLocale({ userLocale: null })).toBe("de");
    state.operatorDefault = null;
    expect(await resolveServerLocale({ userLocale: null })).toBe("en");
  });

  it("resolves outside a request from the stored language", async () => {
    state.outsideRequest = true;
    expect(await resolveServerLocale({ userLocale: "ko" })).toBe("ko");
    state.operatorDefault = "es";
    expect(await resolveServerLocale({ userLocale: null })).toBe("es");
  });
});
