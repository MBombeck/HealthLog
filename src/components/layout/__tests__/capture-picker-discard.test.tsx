import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookState = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
}));
const captureState = vi.hoisted(() => ({
  dirty: true,
  nutrientsEnabled: true,
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

vi.mock("@/hooks/use-module-enabled", () => ({
  useModuleEnabled: () => captureState.nutrientsEnabled,
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
vi.mock("@/components/insights/nutrients/water-quick-add-sheet", () => ({
  WaterQuickAddSheet: markedComponent("WaterQuickAddSheet"),
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

class WaterDraftHarness {
  private mounted = false;
  private amount = "";

  observe(tree: ReactNode): TestElement | null {
    const sheet = findMarked(tree, "WaterQuickAddSheet");
    if (!sheet) {
      this.mounted = false;
      this.amount = "";
    } else if (!this.mounted) {
      this.mounted = true;
      this.amount = "";
    }
    return sheet;
  }

  fill(value: string) {
    expect(this.mounted).toBe(true);
    this.amount = value;
  }

  value() {
    return this.amount;
  }
}

describe("<CapturePicker> — confirmed water discard", () => {
  beforeEach(() => {
    hookState.cursor = 0;
    hookState.values.length = 0;
    captureState.dirty = true;
    captureState.nutrientsEnabled = true;
  });

  it("reopens with a fresh custom amount after confirmed discard", () => {
    const draft = new WaterDraftHarness();
    let tree = renderPicker();
    draft.observe(tree);

    const waterOption = findByTestId(tree, "capture-picker-water");
    (waterOption.props.onClick as () => void)();

    tree = renderPicker();
    const waterSheet = draft.observe(tree);
    expect(waterSheet?.props.open).toBe(true);
    draft.fill("375");

    (waterSheet?.props.onOpenChange as (open: boolean) => void)(false);
    tree = renderPicker();
    const confirmDiscard = findMarked(tree, "AlertDialogAction");
    expect(confirmDiscard).not.toBeNull();
    expect(draft.observe(tree)?.props.open).toBe(true);
    expect(draft.value()).toBe("375");
    (confirmDiscard?.props.onClick as () => void)();

    tree = renderPicker();
    expect(draft.observe(tree)).toBeNull();

    const reopenedWaterOption = findByTestId(tree, "capture-picker-water");
    (reopenedWaterOption.props.onClick as () => void)();
    tree = renderPicker();
    expect(draft.observe(tree)?.props.open).toBe(true);
    expect(draft.value()).toBe("");
  });
});
