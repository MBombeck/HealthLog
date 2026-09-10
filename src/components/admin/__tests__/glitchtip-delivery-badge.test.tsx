/**
 * The GlitchTip badge answers "are reports arriving", not "did somebody type
 * a DSN".
 *
 * The two questions used to have one answer: enabled plus a URL that parses.
 * A wrong public key, a wrong project id and a host that stopped answering all
 * parse perfectly, so a green badge over any of them is the false reassurance
 * an operator only discovers when they go looking for a crash that was never
 * reported. The card now reads the delivery outcome this host recorded.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminSettings } from "../_shared";

const settingsResult = vi.hoisted(() => ({
  current: null as Partial<AdminSettings> | null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: settingsResult.current }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("../_shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared")>();
  return {
    ...actual,
    useAdminSettings: () => ({ data: settingsResult.current }),
    useUpdateSettings: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import { GlitchtipSection } from "../glitchtip-section";

const BASE = {
  glitchtipEnabled: true,
  glitchtipDsn: "https://public-key@glitchtip.example.com/7",
  glitchtipEnvironment: "production",
  glitchtipReportsDelivering: false,
  glitchtipEverDelivered: false,
  glitchtipLastFailureReason: null,
  glitchtipDeliveryWindowHours: 336,
} satisfies Partial<AdminSettings>;

function render(settings: Partial<AdminSettings> | null): string {
  settingsResult.current = settings;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <GlitchtipSection />
    </I18nProvider>,
  );
}

describe("<GlitchtipSection> delivery badge", () => {
  it("does not call a parseable DSN configured until something has left the host", () => {
    const html = render(BASE);
    expect(html).toContain("Unproven");
    expect(html).not.toContain(">Configured<");
    expect(html).toContain("no report has left this host yet");
  });

  it("names the failure when the target refused the last report", () => {
    const html = render({ ...BASE, glitchtipLastFailureReason: "http_403" });
    expect(html).toContain("Unproven");
    expect(html).toContain("did not get through");
    expect(html).toContain("http_403");
  });

  it("goes green only for a report that left inside the window", () => {
    const html = render({
      ...BASE,
      glitchtipReportsDelivering: true,
      glitchtipEverDelivered: true,
    });
    expect(html).toContain(">Configured<");
    expect(html).toContain("glitchtip.example.com");
    expect(html).not.toContain('data-slot="glitchtip-delivery"');
  });

  it("stops claiming delivery once the last success ages out of the window", () => {
    const html = render({
      ...BASE,
      glitchtipDeliveryWindowHours: 24,
      glitchtipEverDelivered: true,
    });
    expect(html).toContain("Unproven");
    expect(html).toContain("No report has left this host in the last");
  });

  it("says nothing is sent when the switch is off", () => {
    const html = render({ ...BASE, glitchtipEnabled: false });
    expect(html).toContain("Error reports stay on this host");
    expect(html).not.toContain("Unproven");
  });
});
