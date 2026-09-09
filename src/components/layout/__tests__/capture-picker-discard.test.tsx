import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookState = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
}));
const captureState = vi.hoisted(() => ({
  dirty: true,
}));

// v1.36.x — the picker asks what the record allows before it offers a kind.
// These fixtures are the caller's own record, which is every kind; the
// delegation cases are covered in
// `src/components/__tests__/delegated-write-affordances.test.tsx`.
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    inSharedRecord: false,
    canWrite: false,
    canAdd: true,
    canManage: true,
    canWriteDomain: () => true,
    canManageDomain: () => true,
  }),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState<T>(initialValue: T | (() => T)) {
      const index = hookState.cursor++;
      if (!(index in hookState.values)) {
        hookState.values[index] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      const setValue = (nextValue: T | ((current: T) => T)) => {
        const current = hookState.values[index] as T;
        hookState.values[index] =
          typeof nextValue === "function"
            ? (nextValue as (value: T) => T)(current)
            : nextValue;
      };
      return [hookState.values[index] as T, setValue] as const;
    },
  };
});

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/dashboard/quick-entry-sheets", () => ({
  sheetBodyHasUnsavedInput: () => captureState.dirty,
}));

function markedComponent(displayName: string) {
  const Component = ({ children }: { children?: ReactNode }) => children;
  Component.displayName = displayName;
  return Component;
}

vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: markedComponent("ResponsiveSheet"),
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: markedComponent("AlertDialog"),
  AlertDialogAction: markedComponent("AlertDialogAction"),
  AlertDialogCancel: markedComponent("AlertDialogCancel"),
  AlertDialogContent: markedComponent("AlertDialogContent"),
  AlertDialogDescription: markedComponent("AlertDialogDescription"),
  AlertDialogFooter: markedComponent("AlertDialogFooter"),
  AlertDialogHeader: markedComponent("AlertDialogHeader"),
  AlertDialogTitle: markedComponent("AlertDialogTitle"),
}));

vi.mock("@/components/measurements/measurement-form", () => ({
  MeasurementForm: markedComponent("MeasurementForm"),
}));
vi.mock("@/components/mood/mood-form", () => ({
  MoodForm: markedComponent("MoodForm"),
}));
vi.mock("@/components/dashboard/medication-intake-quick-add", () => ({
  MedicationIntakeQuickAdd: markedComponent("MedicationIntakeQuickAdd"),
}));

import { CapturePicker } from "../capture-picker";

type ElementProps = Record<string, unknown> & { children?: ReactNode };
type TestElement = ReactElement<ElementProps>;

function elementsIn(node: ReactNode): TestElement[] {
  if (Array.isArray(node)) return node.flatMap(elementsIn);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elementsIn(node.props.children)];
}

function renderPicker(): ReactNode {
  hookState.cursor = 0;
  return CapturePicker({ open: true, onOpenChange: vi.fn() });
}

function findByTestId(tree: ReactNode, testId: string): TestElement {
  const element = elementsIn(tree).find(
    (candidate) => candidate.props["data-testid"] === testId,
  );
  expect(element, `missing data-testid=${testId}`).toBeDefined();
  return element!;
}

function findMarked(tree: ReactNode, displayName: string): TestElement | null {
  return (
    elementsIn(tree).find(
      (element) =>
        typeof element.type === "function" &&
        "displayName" in element.type &&
        element.type.displayName === displayName,
    ) ?? null
  );
}

/**
 * The chosen capture surface lives in the second `ResponsiveSheet` (the
 * first hosts the kind chooser). Its `open` prop reflects the picked kind
 * and its `onOpenChange` is the dirty-dismiss interceptor under test.
 */
function formSheet(tree: ReactNode): TestElement {
  const sheets = elementsIn(tree).filter(
    (element) =>
      typeof element.type === "function" &&
      "displayName" in element.type &&
      element.type.displayName === "ResponsiveSheet",
  );
  expect(sheets.length).toBeGreaterThanOrEqual(2);
  return sheets[1];
}

describe("<CapturePicker> — confirmed capture-form discard", () => {
  beforeEach(() => {
    hookState.cursor = 0;
    hookState.values.length = 0;
    captureState.dirty = true;
  });

  it("asks before discarding a dirty form and closes on confirm", () => {
    let tree = renderPicker();

    // Choose the mood capture; the form sheet opens with the mood form.
    const moodOption = findByTestId(tree, "capture-picker-mood");
    (moodOption.props.onClick as () => void)();

    tree = renderPicker();
    expect(formSheet(tree).props.open).toBe(true);
    expect(findMarked(tree, "MoodForm")).not.toBeNull();

    // A dirty dismiss must not close outright — it raises the confirm.
    (formSheet(tree).props.onOpenChange as (open: boolean) => void)(false);
    tree = renderPicker();
    const confirmDiscard = findMarked(tree, "AlertDialogAction");
    expect(confirmDiscard).not.toBeNull();
    // The form stays open behind the confirm.
    expect(formSheet(tree).props.open).toBe(true);
    expect(findMarked(tree, "MoodForm")).not.toBeNull();

    // Confirming the discard closes the form.
    (confirmDiscard?.props.onClick as () => void)();
    tree = renderPicker();
    expect(formSheet(tree).props.open).toBe(false);
    expect(findMarked(tree, "MoodForm")).toBeNull();
  });
});
