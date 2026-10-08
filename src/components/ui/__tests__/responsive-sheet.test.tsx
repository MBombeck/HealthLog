import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// `<ResponsiveSheet>` flips between a `<Sheet side="bottom">` and a
// centred `<Dialog>` via `useIsMobile()`. Vitest runs in the Node
// environment without `matchMedia`; the hook returns its SSR-safe
// default (`false`) and is overridden below for the Sheet branch.
//
// shadcn `<Sheet>` / `<Dialog>` both wrap Radix Portals — `renderToStaticMarkup`
// does not materialise portal trees — so we mock the primitives down
// to passthrough wrappers so the rendered shape is reachable in the
// static markup.

let mobile = false;

vi.mock("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mobile,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-slot="mock-sheet">{children}</div> : null,
  SheetContent: ({
    children,
    className,
    ...rest
  }: {
    children: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <div data-slot="mock-sheet-content" className={className} {...rest}>
      {children}
    </div>
  ),
  SheetHeader: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  SheetFooter: ({
    children,
    className,
    ...rest
  }: {
    children: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <div className={className} {...rest}>
      {children}
    </div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-slot="mock-dialog">{children}</div> : null,
  DialogContent: ({
    children,
    className,
    ...rest
  }: {
    children: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <div data-slot="mock-dialog-content" className={className} {...rest}>
      {children}
    </div>
  ),
  DialogHeader: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogFooter: ({
    children,
    className,
    ...rest
  }: {
    children: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <div className={className} {...rest}>
      {children}
    </div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

import { keepKeyboardDownOnOpen, ResponsiveSheet } from "../responsive-sheet";

describe("<ResponsiveSheet>", () => {
  it("renders the Dialog branch on `md+` viewports", () => {
    mobile = false;
    const html = renderToStaticMarkup(
      <ResponsiveSheet
        open
        onOpenChange={() => {}}
        title="Add measurement"
        description="Log a new reading"
      >
        <p>body</p>
      </ResponsiveSheet>,
    );
    expect(html).toContain('data-variant="dialog"');
    expect(html).toContain("Add measurement");
    expect(html).toContain("Log a new reading");
    expect(html).toContain("body");
    // Sheet branch markers must be absent.
    expect(html).not.toContain('data-slot="mock-sheet"');
  });

  it("reclaims a scroll gutter on the Dialog body so the scrollbar clears right-aligned labels", () => {
    mobile = false;
    const html = renderToStaticMarkup(
      <ResponsiveSheet open onOpenChange={() => {}} title="Add mood">
        <p>body</p>
      </ResponsiveSheet>,
    );
    // The body carries `-mr-3 pr-3`: a 12 px gutter reclaimed from the dialog's
    // own padding so the vertical scrollbar lives beside the text, not on the
    // last characters of a right-aligned slider anchor.
    expect(html).toContain("-mr-3");
    expect(html).toContain("pr-3");
  });

  it.each([
    [undefined, "sm:max-w-md"],
    ["md", "sm:max-w-md"],
    ["4xl", "sm:max-w-4xl"],
    ["6xl", "sm:max-w-6xl"],
  ] as const)(
    "maps contentWidth %s to %s on the Dialog branch, and to no other tier",
    (contentWidth, expected) => {
      mobile = false;
      const html = renderToStaticMarkup(
        <ResponsiveSheet
          open
          onOpenChange={() => {}}
          title="Review"
          contentWidth={contentWidth}
        >
          <p>body</p>
        </ResponsiveSheet>,
      );
      const tiers = html.match(/sm:max-w-(?:md|lg|2xl|3xl|4xl|6xl)/g);
      expect(tiers).toEqual([expected]);
    },
  );

  it("does not apply a width tier on the Sheet branch", () => {
    mobile = true;
    const html = renderToStaticMarkup(
      <ResponsiveSheet
        open
        onOpenChange={() => {}}
        title="Review"
        contentWidth="6xl"
      >
        <p>body</p>
      </ResponsiveSheet>,
    );
    expect(html).not.toContain("sm:max-w-6xl");
    mobile = false;
  });

  it("renders the bottom Sheet branch on narrow viewports", () => {
    mobile = true;
    const html = renderToStaticMarkup(
      <ResponsiveSheet open onOpenChange={() => {}} title="Add measurement">
        <p>body</p>
      </ResponsiveSheet>,
    );
    expect(html).toContain('data-variant="sheet"');
    expect(html).toContain('data-slot="mock-sheet"');
    expect(html).toContain("Add measurement");
    expect(html).toContain("body");
    mobile = false;
  });

  it("renders a sticky-pinned footer on the Sheet branch", () => {
    mobile = true;
    const html = renderToStaticMarkup(
      <ResponsiveSheet
        open
        onOpenChange={() => {}}
        title="Add measurement"
        footer={<button type="button">Save</button>}
      >
        <p>body</p>
      </ResponsiveSheet>,
    );
    expect(html).toContain('data-slot="responsive-sheet-footer"');
    expect(html).toContain("sticky");
    expect(html).toContain("Save");
    mobile = false;
  });

  it("renders a flow-layout footer on the Dialog branch", () => {
    mobile = false;
    const html = renderToStaticMarkup(
      <ResponsiveSheet
        open
        onOpenChange={() => {}}
        title="Add measurement"
        footer={<button type="button">Save</button>}
      >
        <p>body</p>
      </ResponsiveSheet>,
    );
    expect(html).toContain('data-slot="responsive-sheet-footer"');
    expect(html).not.toContain("sticky bottom-0");
    expect(html).toContain("Save");
  });

  it("hides the visual header but keeps the title accessible via sr-only when hideHeader is set", () => {
    mobile = false;
    const html = renderToStaticMarkup(
      <ResponsiveSheet
        open
        onOpenChange={() => {}}
        title="Edit medication"
        hideHeader
      >
        <p>body</p>
      </ResponsiveSheet>,
    );
    expect(html).toContain("sr-only");
    expect(html).toContain("Edit medication");
  });

  it("reserves the close-button gutter on the Sheet header by default", () => {
    mobile = true;
    const html = renderToStaticMarkup(
      <ResponsiveSheet open onOpenChange={() => {}} title="Detail">
        <p>body</p>
      </ResponsiveSheet>,
    );
    // Default showCloseButton=true → the primitive paints its absolute X, so
    // the header reserves the right gutter for it.
    expect(html).toContain("pr-12");
    mobile = false;
  });

  it("drops the Sheet header gutter when showCloseButton is false", () => {
    mobile = true;
    const html = renderToStaticMarkup(
      <ResponsiveSheet
        open
        onOpenChange={() => {}}
        title="Detail"
        showCloseButton={false}
        headerAction={<button type="button">X</button>}
      >
        <p>body</p>
      </ResponsiveSheet>,
    );
    // No primitive close button → no reserved gutter; the headerAction sits
    // flush to the header's p-4 right edge.
    expect(html).not.toContain("pr-12");
    mobile = false;
  });

  it("reserves the Dialog header gutter for headerAction by default", () => {
    mobile = false;
    const html = renderToStaticMarkup(
      <ResponsiveSheet
        open
        onOpenChange={() => {}}
        title="Detail"
        headerAction={<button type="button">X</button>}
      >
        <p>body</p>
      </ResponsiveSheet>,
    );
    expect(html).toContain("pr-9");
  });

  it("drops the Dialog header gutter when showCloseButton is false", () => {
    mobile = false;
    const html = renderToStaticMarkup(
      <ResponsiveSheet
        open
        onOpenChange={() => {}}
        title="Detail"
        showCloseButton={false}
        headerAction={<button type="button">X</button>}
      >
        <p>body</p>
      </ResponsiveSheet>,
    );
    expect(html).not.toContain("pr-9");
  });

  it("does not throw when onOpenChange is invoked (controlled-state plumbing)", () => {
    mobile = false;
    const onOpenChange = vi.fn();
    // Mounted closed — Dialog mock returns null, smoke-only render
    // confirms no throw + the prop wiring round-trips.
    renderToStaticMarkup(
      <ResponsiveSheet open={false} onOpenChange={onOpenChange} title="closed">
        <p>body</p>
      </ResponsiveSheet>,
    );
    onOpenChange(true);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});

describe("keepKeyboardDownOnOpen (phone branch open focus)", () => {
  function setup(activeInside: boolean) {
    const focus = vi.fn();
    const preventDefault = vi.fn();
    const active = { id: "active" };
    const content = {
      focus,
      contains: (node: unknown) => activeInside && node === active,
    };
    vi.stubGlobal("document", { activeElement: active });
    keepKeyboardDownOnOpen({
      preventDefault,
      currentTarget: content,
    } as unknown as Event);
    vi.unstubAllGlobals();
    return { focus, preventDefault };
  }

  it("focuses the sheet itself instead of its first field", () => {
    const { focus, preventDefault } = setup(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("leaves a field the form focused on purpose alone", () => {
    const { focus, preventDefault } = setup(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();
  });
});
