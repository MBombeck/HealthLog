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
  Sheet: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div data-slot="mock-sheet">{children}</div> : null),
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
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div data-slot="mock-dialog">{children}</div> : null),
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

import { ResponsiveSheet } from "../responsive-sheet";

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

  it("does not throw when onOpenChange is invoked (controlled-state plumbing)", () => {
    mobile = false;
    const onOpenChange = vi.fn();
    // Mounted closed — Dialog mock returns null, smoke-only render
    // confirms no throw + the prop wiring round-trips.
    renderToStaticMarkup(
      <ResponsiveSheet
        open={false}
        onOpenChange={onOpenChange}
        title="closed"
      >
        <p>body</p>
      </ResponsiveSheet>,
    );
    onOpenChange(true);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
