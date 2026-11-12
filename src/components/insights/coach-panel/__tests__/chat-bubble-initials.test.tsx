import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * The person's bubble falls back to initials of the name the app shows, like
 * the top bar, never the login: a managed record's login is a generated
 * handle, and "MA" for `managed-…` is nobody's initials.
 */
const auth = vi.hoisted(() => ({
  user: {
    id: "u1",
    username: "managed-1f2e3d",
    displayName: "Alex Example" as string | null,
    role: "USER",
    avatarUrl: null,
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: auth.user, isAuthenticated: true, isLoading: false }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ChatBubble } from "../chat-bubble";

function userBubble(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ChatBubble role="user" content="How did I sleep?" />
    </I18nProvider>,
  );
}

describe("coach bubble initials", () => {
  it("spells the display name, not the login", () => {
    const html = userBubble();
    expect(html).toContain(">AE<");
    expect(html).not.toContain(">MA<");
  });

  it("falls back to the login when there is no display name", () => {
    auth.user.displayName = null;
    auth.user.username = "sam";
    expect(userBubble()).toContain(">S<");
  });
});
