/**
 * The Apple Health write-back controls on the API settings (#1272).
 *
 * SSR-only, as the rest of this directory: which tokens carry the setting,
 * when the notice about readings that belong to no token shows, and the write
 * the row menu sends, pinned against a stubbed `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

import {
  UnattributedReadingsNotice,
  isMeasurementTokenInfo,
  patchTokenMirror,
} from "../apple-health-mirror-token";

function render(node: React.ReactNode, client = new QueryClient()) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("which tokens carry the setting", () => {
  it("is a measurement token, and nothing else", () => {
    expect(isMeasurementTokenInfo(["measurements:write"])).toBe(true);
    for (const permissions of [
      ["*"],
      ["health:read"],
      ["workouts:write"],
      ["measurements:write", "health:read"],
    ]) {
      expect(isMeasurementTokenInfo(permissions)).toBe(false);
    }
  });
});

describe("the notice about readings no token reaches", () => {
  function withSummary(unattributedReadings: number) {
    const client = new QueryClient();
    client.setQueryData(queryKeys.measurementTokenSummary(), {
      unattributedReadings,
    });
    return render(<UnattributedReadingsNotice />, client);
  }

  it("shows only when there are such readings", () => {
    expect(withSummary(3)).toContain(
      "Readings sent before this setting existed can&#x27;t be matched to a token",
    );
    expect(withSummary(0)).toBe("");
    expect(render(<UnattributedReadingsNotice />)).toBe("");
  });
});

describe("the write", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { id: "tok 1", mirrorToAppleHealth: true },
            error: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("patches the token with the one field", async () => {
    await expect(patchTokenMirror("tok 1", true)).resolves.toEqual({
      id: "tok 1",
      mirrorToAppleHealth: true,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tokens/tok%201");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      mirrorToAppleHealth: true,
    });
  });
});
