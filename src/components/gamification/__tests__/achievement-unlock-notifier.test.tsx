import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.18.0 — `<AchievementUnlockNotifier>` honours the achievements module
 * gate. When the module is disabled the polling query is never enabled,
 * so no unlock toast can surface — the engagement surface disappears in
 * lock-step with the page, the dashboard tile, and the 403 route.
 */

let mockUser: { modules?: Record<string, boolean> } | null = {};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: mockUser }),
}));

const useAchievementsQuery = vi.fn<
  (opts?: { enabled?: boolean }) => { data: undefined }
>(() => ({
  data: undefined,
}));

vi.mock("@/lib/queries/use-achievements-query", () => ({
  useAchievementsQuery: (opts?: { enabled?: boolean }) =>
    useAchievementsQuery(opts),
}));

const toast = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign((...args: unknown[]) => toast(...args), {
    getToasts: () => [],
  }),
}));

import { AchievementUnlockNotifier } from "../achievement-unlock-notifier";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AchievementUnlockNotifier userId="user-1" />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = {};
});

describe("<AchievementUnlockNotifier> — achievements module gate", () => {
  it("disables the polling query when the module is off", () => {
    mockUser = { modules: { achievements: false } };
    expect(render()).toBe("");
    expect(useAchievementsQuery).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("enables the polling query when the module is on (explicit true)", () => {
    mockUser = { modules: { achievements: true } };
    render();
    expect(useAchievementsQuery).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it("enables the query by default when the module key is absent (default-on)", () => {
    mockUser = { modules: {} };
    render();
    expect(useAchievementsQuery).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });
});
