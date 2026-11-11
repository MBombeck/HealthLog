/**
 * `/insights/bmi` decides from a height whether it can show anything. It used
 * the height of the person at the keyboard, so inside somebody else's record
 * a viewer without a height of their own was asked to set it, and a viewer
 * with one hid that the record has none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const shellProps = vi.fn();
vi.mock("@/components/insights/sub-page-shell", () => ({
  SubPageShell: (props: Record<string, unknown>) => {
    shellProps(props);
    return null;
  },
}));

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key, locale: "en" }),
}));

const state = {
  viewerHeight: null as number | null,
  inSharedRecord: true,
  recordHeight: 118 as number | null,
};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { heightCm: state.viewerHeight, timezone: "UTC" },
  }),
}));
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ inSharedRecord: state.inSharedRecord }),
}));
vi.mock("@/hooks/use-insights-analytics", () => ({
  useInsightsAnalytics: () => ({ isEmpty: false }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ enabled }: { enabled?: boolean }) => ({
    data:
      enabled === false
        ? undefined
        : { profile: { heightCm: state.recordHeight } },
  }),
}));

import InsightsBmiPage from "../page";

/** True when the page rendered its "set your height" state. */
function asksForHeight(): boolean {
  renderToStaticMarkup(<InsightsBmiPage />);
  const props = shellProps.mock.calls.at(-1)![0] as { coachLaunch?: boolean };
  // The chart branch launches the Coach from the shell; the empty states do not.
  return props.coachLaunch !== true;
}

describe("/insights/bmi height gate", () => {
  beforeEach(() => {
    shellProps.mockClear();
    state.viewerHeight = null;
    state.inSharedRecord = true;
    state.recordHeight = 118;
  });

  it("reads the record's height inside somebody else's record", () => {
    expect(asksForHeight()).toBe(false);
    state.viewerHeight = 180;
    state.recordHeight = null;
    expect(asksForHeight()).toBe(true);
  });

  it("reads the account's own height in one's own record", () => {
    state.inSharedRecord = false;
    state.viewerHeight = 180;
    expect(asksForHeight()).toBe(false);
    state.viewerHeight = null;
    expect(asksForHeight()).toBe(true);
  });
});
