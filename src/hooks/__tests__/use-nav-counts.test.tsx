/**
 * The navigation counts follow the person's switch (#1113): on by default,
 * and while it is off no count is drawn and `/api/nav/counts` is never asked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Pill } from "lucide-react";

const useAuthMock = vi.fn();
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => useAuthMock() }));
const inSharedRecordMock = vi.fn(() => false);
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ inSharedRecord: inSharedRecordMock() }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
const apiGetMock = vi.fn();
vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

// The query layer stands in as a recorder: it hands back the server's counts
// and runs the query function only when the options enable it, so the test
// sees both what the hook returns and whether it asked at all.
const queryOptions: Array<{ enabled?: boolean; queryFn: () => unknown }> = [];
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { enabled?: boolean; queryFn: () => unknown }) => {
    queryOptions.push(options);
    if (options.enabled !== false) options.queryFn();
    return { data: { dosesDue: 2, checkupsDue: 1 } };
  },
}));

import { MoreHubGroups } from "@/components/layout/more-hub-groups";
import { useNavCounts } from "@/hooks/use-nav-counts";
import { I18nProvider } from "@/lib/i18n/context";

function Probe({ enabled }: { enabled: boolean }) {
  return <span>{JSON.stringify(useNavCounts(enabled))}</span>;
}

function counts(enabled = true): Record<string, number> {
  const html = renderToStaticMarkup(<Probe enabled={enabled} />);
  return JSON.parse(
    html.replace(/^<span>|<\/span>$/g, "").replace(/&quot;/g, '"'),
  ) as Record<string, number>;
}

function moreSheet(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MoreHubGroups
        entries={[
          {
            href: "/medications",
            tKey: "nav.medications",
            icon: Pill,
            group: "tracking",
          },
        ]}
        isActive={() => false}
        onNavigate={() => {}}
      />
    </I18nProvider>,
  );
}

describe("useNavCounts and the switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryOptions.length = 0;
    inSharedRecordMock.mockReturnValue(false);
  });

  it("shows the counts and asks for them by default", () => {
    useAuthMock.mockReturnValue({ user: { showNavCounts: true } });
    expect(counts()).toEqual({ "/medications": 2, "/checkups": 1 });
    expect(queryOptions.at(-1)?.enabled).toBe(true);
    expect(apiGetMock).toHaveBeenCalledWith("/api/nav/counts");
  });

  it("keeps them on before the account resolves", () => {
    useAuthMock.mockReturnValue({ user: null });
    expect(counts()).toEqual({ "/medications": 2, "/checkups": 1 });
  });

  it("shows nothing and never asks while the switch is off", () => {
    useAuthMock.mockReturnValue({ user: { showNavCounts: false } });
    expect(counts()).toEqual({});
    expect(queryOptions.length).toBeGreaterThan(0);
    expect(queryOptions.every((o) => o.enabled === false)).toBe(true);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("draws the badge in the More sheet only while the switch is on", () => {
    useAuthMock.mockReturnValue({ user: { showNavCounts: true } });
    expect(moreSheet().match(/data-slot="nav-count"/g)).toHaveLength(1);

    useAuthMock.mockReturnValue({ user: { showNavCounts: false } });
    const html = moreSheet();
    expect(html).not.toContain('data-slot="nav-count"');
    expect(html).toContain("Medications");
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });
});
