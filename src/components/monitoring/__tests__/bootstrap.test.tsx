import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The monitoring switches come from the root layout's render, not from a
 * request on every page load for three instance-wide values. The first
 * render already mounts what they turn on.
 */

const apiGet = vi.fn();
vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
}));
vi.mock("@/components/monitoring/umami-script", () => ({
  UmamiScript: (props: { enabled: boolean; websiteId: string | null }) => (
    <i data-umami={`${props.enabled}:${props.websiteId}`} />
  ),
}));
vi.mock("@/components/monitoring/glitchtip-reporter", () => ({
  GlitchtipReporter: (props: { enabled: boolean }) => (
    <i data-glitchtip={String(props.enabled)} />
  ),
}));

import { MonitoringBootstrap } from "../bootstrap";

describe("MonitoringBootstrap", () => {
  it("mounts what the layout's switches turn on, without asking the server", () => {
    const html = renderToStaticMarkup(
      <MonitoringBootstrap
        settings={{
          umamiEnabled: true,
          umamiWebsiteId: "site-1",
          glitchtipEnabled: true,
        }}
      />,
    );

    expect(html).toContain('data-umami="true:site-1"');
    expect(html).toContain('data-glitchtip="true"');
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("mounts nothing without settings", () => {
    expect(renderToStaticMarkup(<MonitoringBootstrap settings={null} />)).toBe(
      "",
    );
  });
});
