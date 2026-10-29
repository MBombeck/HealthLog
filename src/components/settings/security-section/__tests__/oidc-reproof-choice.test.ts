/**
 * The web side of confirming at the identity provider (#1296): the dialogs
 * offer it when the server names it, the round trip starts from and returns
 * to the page the person is on, and the outcome marker is read once.
 */
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-fetch";
import { oidcReproofStartUrl } from "../existing-factor-reauth-dialog";
import { passkeyProofChoices } from "../passkey-list-section";
import { createRecentProofFlow } from "../recent-proof-flow";
import { readReproofReturn } from "@/components/auth/oidc-reproof-return";

describe("passkeyProofChoices", () => {
  it("offers only what the account can give once its list is known", () => {
    expect(passkeyProofChoices(["oidc"])).toEqual(["oidc"]);
    expect(passkeyProofChoices(["password", "oidc", "passkey"])).toEqual([
      "password",
      "oidc",
      "passkey",
    ]);
    expect(passkeyProofChoices(["totp", "something-new"])).toEqual(["totp"]);
  });

  it("falls back to the four body proofs while the list is loading", () => {
    expect(passkeyProofChoices(undefined)).toEqual([
      "password",
      "totp",
      "passkey",
      "webauthn",
    ]);
  });
});

describe("oidcReproofStartUrl", () => {
  it("names the current page as the way back, without an old outcome", () => {
    const href = oidcReproofStartUrl({
      pathname: "/settings/api",
      search: "?tab=mcp&reproof=failed",
    });
    const url = new URL(href, "https://healthlog.example.test");
    expect(url.pathname).toBe("/api/auth/oidc/reproof");
    expect(url.searchParams.get("next")).toBe("/settings/api?tab=mcp");
  });
});

describe("readReproofReturn", () => {
  it("reads a known outcome off the query string", () => {
    expect(readReproofReturn("?tab=mcp&reproof=done")).toBe("done");
    expect(readReproofReturn("?reproof=failed")).toBe("failed");
  });

  it("ignores an address without a known outcome", () => {
    expect(readReproofReturn("")).toBeNull();
    expect(readReproofReturn("?reproof=maybe")).toBeNull();
  });
});

describe("the re-proof dialog flow", () => {
  it("opens with the identity provider when that is the account's only way", async () => {
    const setMethods = vi.fn();
    const flow = createRecentProofFlow({
      view: { setMethods, setPending: vi.fn(), setError: vi.fn() },
      submit: vi.fn(),
      messages: () => ({ signInAgain: "sign in again", failed: "failed" }),
    });
    void flow
      .run(async () => {
        throw new ApiError("Confirm it is you", 401, {
          errorCode: "auth.reproof.required",
          methods: ["oidc"],
        });
      })
      .catch(() => {});
    await vi.waitFor(() => expect(setMethods).toHaveBeenCalledWith(["oidc"]));
    flow.cancel();
  });
});
