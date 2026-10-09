import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// The sheet primitive portals through Radix, which renders nothing on the
// server; this stand-in keeps its contract (title + description name the
// surface) so the list itself can be read. Focus trap and Escape are the
// primitive's and are proven in `e2e/keyboard-shortcuts.spec.ts`.
vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    open,
    title,
    description,
    children,
  }: {
    open: boolean;
    title: React.ReactNode;
    description?: React.ReactNode;
    children: React.ReactNode;
  }) =>
    open ? (
      <section role="dialog" aria-label={String(title)}>
        <h2>{title}</h2>
        <p>{description}</p>
        {children}
      </section>
    ) : null,
}));

import { KeyboardShortcutsDialog } from "../keyboard-shortcuts-dialog";

const EVERYTHING = {
  navHrefs: ["/", "/medications", "/labs", "/timeline", "/insights", "/coach"],
  settingsHref: "/settings/account",
};

function render(
  props: Partial<React.ComponentProps<typeof KeyboardShortcutsDialog>> = {},
  locale = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale as "en"}>
      <KeyboardShortcutsDialog
        open
        onOpenChange={() => undefined}
        offer={EVERYTHING}
        canCapture
        {...props}
      />
    </I18nProvider>,
  );
}

describe("<KeyboardShortcutsDialog>", () => {
  it("renders nothing while closed", () => {
    expect(render({ open: false })).toBe("");
  });

  it("is titled and lists three groups", () => {
    const html = render();
    expect(html).toContain('aria-label="Keyboard shortcuts"');
    expect(html).toContain('data-group="navigation"');
    expect(html).toContain('data-group="actions"');
    expect(html).toContain('data-group="day"');
  });

  it("shows every destination as g then its key, in kbd", () => {
    const html = render();
    for (const k of ["d", "m", "l", "t", "i", "c", "s"]) {
      expect(html).toContain(`data-shortcut="go-${k}"`);
    }
    expect(html).toMatch(/<kbd[^>]*>g<\/kbd>/);
    expect(html).toContain(">then<");
    expect(html).toMatch(/<kbd[^>]*>\?<\/kbd>/);
    expect(html).toMatch(/<kbd[^>]*>\[<\/kbd>/);
    expect(html).toMatch(/<kbd[^>]*>\]<\/kbd>/);
    expect(html).toMatch(/<kbd[^>]*>Esc<\/kbd>/);
  });

  it("drops a destination the session does not offer", () => {
    const html = render({
      offer: { navHrefs: ["/", "/insights"], settingsHref: null },
    });
    expect(html).toContain('data-shortcut="go-d"');
    expect(html).toContain('data-shortcut="go-i"');
    for (const k of ["m", "l", "t", "c", "s"]) {
      expect(html).not.toContain(`data-shortcut="go-${k}"`);
    }
  });

  it("drops n where there is nothing to log", () => {
    expect(render({ canCapture: false })).not.toContain(
      'data-shortcut="capture"',
    );
    expect(render()).toContain('data-shortcut="capture"');
  });

  it("uses token classes for the keys, no raw colour", () => {
    const kbd = render().match(/<kbd class="([^"]+)"/)?.[1] ?? "";
    expect(kbd).toContain("bg-muted");
    expect(kbd).toContain("text-foreground");
    expect(kbd).not.toMatch(/#[0-9a-f]{3,6}|dracula|\[/i);
  });

  it.each(["de", "es", "fr", "it", "pl", "ko"])(
    "is translated in %s",
    (locale) => {
      const html = render({}, locale);
      expect(html).not.toContain('aria-label="Keyboard shortcuts"');
      expect(html).not.toContain("shortcuts.");
    },
  );
});
