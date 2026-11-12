/**
 * The strip behind the status bar on the sign-in pages.
 *
 * The installed iOS app draws the clock in white over whatever the page
 * paints there. The signed-in shell paints the strip; the sign-in pages only
 * padded it, so after a sign-out in the light theme the clock was white on
 * near-white.
 */
import { afterEach, describe, expect, it } from "vitest";

import { renderWithApp } from "../../../../tests/browser/render";
import { stubFetch } from "../../../../tests/browser/fetch-stub";

import { AuthShell } from "../auth-shell";

afterEach(() => {
  document.documentElement.classList.remove("light");
  document.documentElement.classList.add("dark");
});

describe("AuthShell status bar strip", () => {
  it("is painted on the sign-in page in the light theme", async () => {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
    stubFetch().on("GET", "/api/auth/me", {
      status: 401,
      error: "Unauthorized",
      meta: { errorCode: "auth.missing" },
    });
    window.history.replaceState(null, "", "/auth/login");
    await renderWithApp(
      <AuthShell>
        <div data-slot="page" />
      </AuthShell>,
      { user: null },
    );
    await expect
      .poll(() => document.querySelector('[data-slot="page"]'))
      .toBeTruthy();

    const wrapper = document.getElementById("main-content")!.parentElement!;
    expect(getComputedStyle(wrapper).backgroundImage).toContain(
      "linear-gradient",
    );
  });
});
