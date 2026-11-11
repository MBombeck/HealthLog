/**
 * The avatar fallback on the settings card spells the name the rest of the
 * app shows. It used to take its letters from the login, so an account named
 * "Robin Example" with the login "rex" read "RE" in the top bar and the
 * sidebar and "R" here.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "rex",
      displayName: "Robin Example",
      avatarUrl: null,
    },
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { AvatarSection } from "../avatar-section";

describe("the settings avatar fallback", () => {
  it("builds its initials from the display name, not the login", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <AvatarSection />
      </I18nProvider>,
    );
    expect(html).toContain(">RE<");
    expect(html).not.toContain(">R<");
  });
});
