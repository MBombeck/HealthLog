/**
 * The theme follows the device unless a person chose one.
 *
 * Nothing stored means "system": the page paints the device's scheme and
 * switches when the device does, without a reload. An explicit light or dark
 * choice is kept whatever the device does. The device scheme is a stubbed
 * `matchMedia`, so the test can flip it mid-run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThemeProvider, useTheme } from "@/components/providers";
import { THEME_STORAGE_KEY } from "@/lib/pwa/theme-color";

function stubDeviceScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.spyOn(window, "matchMedia").mockImplementation(
    () => query as unknown as MediaQueryList,
  );
  return {
    set(next: boolean) {
      dark = next;
      for (const fn of listeners) fn();
    },
  };
}

function Probe() {
  const { theme, resolvedTheme } = useTheme();
  return (
    <p data-testid="probe" data-theme={theme} data-resolved={resolvedTheme} />
  );
}

const root = () => document.documentElement.classList;

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    root().remove("dark", "light");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it("follows a light device with nothing stored, and switches live", async () => {
    const device = stubDeviceScheme(false);
    const screen = await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    const probe = screen.getByTestId("probe");
    await expect.element(probe).toHaveAttribute("data-theme", "system");
    await expect.element(probe).toHaveAttribute("data-resolved", "light");
    expect(root().contains("light")).toBe(true);

    device.set(true);
    await expect.element(probe).toHaveAttribute("data-resolved", "dark");
    expect(root().contains("dark")).toBe(true);
    expect(root().contains("light")).toBe(false);
    // Following the system is not a choice: nothing is written.
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("keeps an explicit choice whatever the device does", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const device = stubDeviceScheme(false);
    const screen = await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    const probe = screen.getByTestId("probe");
    await expect.element(probe).toHaveAttribute("data-resolved", "dark");
    device.set(false);
    await expect.element(probe).toHaveAttribute("data-resolved", "dark");
    expect(root().contains("dark")).toBe(true);
  });

  it("keeps a stored light choice on a dark device", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    stubDeviceScheme(true);
    const screen = await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await expect
      .element(screen.getByTestId("probe"))
      .toHaveAttribute("data-resolved", "light");
    expect(root().contains("light")).toBe(true);
  });
});
