import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CoachLaunchProvider,
  useCoachLaunch,
} from "../coach-launch-context";

/**
 * v1.4.27 R3d MB4 — Coach launch context smoke contract.
 *
 * The project's test convention is `renderToStaticMarkup` (no
 * `@testing-library/react` dependency). We can't simulate interaction
 * inside SSR, but we can verify:
 *   1. The provider mounts and renders its children.
 *   2. The hook returns a value-shape (open, prefill, askCoach,
 *      setOpen) when called beneath the provider.
 *   3. The hook returns `null` when called outside the provider —
 *      consumers degrade gracefully (e.g. the launch button renders
 *      nothing rather than crashing).
 */

function Probe({ output }: { output: string[] }) {
  const launch = useCoachLaunch();
  if (!launch) {
    output.push("null");
    return null;
  }
  output.push(
    JSON.stringify({
      hasAskCoach: typeof launch.askCoach,
      hasSetOpen: typeof launch.setOpen,
      open: launch.open,
      prefill: launch.prefill,
    }),
  );
  return <span data-slot="probe-output">{output.join(",")}</span>;
}

describe("CoachLaunchProvider", () => {
  it("returns null when consumed outside the provider", () => {
    const output: string[] = [];
    renderToStaticMarkup(<Probe output={output} />);
    expect(output).toEqual(["null"]);
  });

  it("exposes the full context shape when consumed beneath the provider", () => {
    const output: string[] = [];
    renderToStaticMarkup(
      <CoachLaunchProvider>
        <Probe output={output} />
      </CoachLaunchProvider>,
    );
    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.hasAskCoach).toBe("function");
    expect(parsed.hasSetOpen).toBe("function");
    expect(parsed.open).toBe(false);
    expect(parsed.prefill).toBeNull();
  });

  it("renders the children inside the provider mount", () => {
    const html = renderToStaticMarkup(
      <CoachLaunchProvider>
        <div data-slot="child-mount">child</div>
      </CoachLaunchProvider>,
    );
    expect(html).toContain('data-slot="child-mount"');
    expect(html).toContain("child");
  });
});
