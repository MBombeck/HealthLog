"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ALL_MEDICATION_CATEGORIES,
  effectiveCategoryFilter as resolveCategoryFilter,
  medicationCategoryOptions,
} from "@/lib/medications/category-filter";
import {
  filterMedications,
  type MedicationListFilters,
} from "@/lib/medications/medication-list-filters";
import type { useTranslations } from "@/lib/i18n/context";

type Translator = ReturnType<typeof useTranslations>["t"];

// The category filter is remembered for the browser session only, by design:
// no preference column, and a new visit starts on All.
const CATEGORY_FILTER_STORAGE_KEY = "healthlog.medications.categoryFilter";
const ALL_CATEGORIES = ALL_MEDICATION_CATEGORIES;
const CATEGORY_FILTER_EVENT = "healthlog:medication-category-filter";

function readStoredCategoryFilter(): string {
  try {
    return (
      window.sessionStorage.getItem(CATEGORY_FILTER_STORAGE_KEY) ??
      ALL_CATEGORIES
    );
  } catch {
    return ALL_CATEGORIES;
  }
}

function storeCategoryFilter(value: string) {
  try {
    if (value === ALL_CATEGORIES) {
      window.sessionStorage.removeItem(CATEGORY_FILTER_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(CATEGORY_FILTER_STORAGE_KEY, value);
    }
  } catch {
    // Storage blocked: the pick still applies until the page unmounts.
  }
  window.dispatchEvent(new Event(CATEGORY_FILTER_EVENT));
}

function subscribeCategoryFilter(onChange: () => void): () => void {
  window.addEventListener(CATEGORY_FILTER_EVENT, onChange);
  return () => window.removeEventListener(CATEGORY_FILTER_EVENT, onChange);
}

// The stored pick, read through useSyncExternalStore so the server render
// (and the first client render) is All and the stored pick follows without a
// hydration mismatch. Blocked storage degrades to a per-view filter.
export function useCategoryFilter(): [string, (value: string) => void] {
  const [fallback, setFallback] = useState<string | null>(null);
  const stored = useSyncExternalStore(
    subscribeCategoryFilter,
    readStoredCategoryFilter,
    () => ALL_CATEGORIES,
  );
  const set = useCallback((value: string) => {
    setFallback(value);
    storeCategoryFilter(value);
  }, []);
  return [fallback ?? stored, set];
}

export interface FilterableMedication {
  id: string;
  name: string;
  category: string;
  categoryLabel?: string | null;
  active: boolean;
  startsOn?: string | null;
  endsOn?: string | null;
}

export interface UseMedicationListFiltersOptions<
  T extends FilterableMedication,
> {
  medications: T[] | undefined;
  activeMeds: T[];
  inactiveMeds: T[];
  t: Translator;
}

export function useMedicationListFilters<T extends FilterableMedication>({
  medications,
  activeMeds,
  inactiveMeds,
  t,
}: UseMedicationListFiltersOptions<T>) {
  const [categoryFilter, setCategoryFilter] = useCategoryFilter();
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");

  const resetAllFilters = useCallback(() => {
    setSearchText("");
    setCategoryFilter(ALL_CATEGORIES);
    setFromDay("");
    setToDay("");
  }, [setCategoryFilter]);

  // "/" focuses the search field unless typing in an input/textarea or open dialog
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented ||
        event.isComposing
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable ||
          target.closest(
            '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
          ))
      ) {
        return;
      }
      const input = searchInputRef.current;
      if (!input || !input.isConnected) return;
      event.preventDefault();
      input.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const medsArray = Array.isArray(medications) ? medications : [];
  const categoriesInUse = medicationCategoryOptions(medsArray, t);
  const effectiveCategoryFilter = resolveCategoryFilter(
    categoryFilter,
    categoriesInUse,
  );
  const isFiltered =
    searchText.trim() !== "" ||
    effectiveCategoryFilter !== ALL_CATEGORIES ||
    fromDay !== "" ||
    toDay !== "";

  const filters: MedicationListFilters = {
    q: searchText,
    category: effectiveCategoryFilter,
    fromDay,
    toDay,
  };
  const shownActiveMeds = filterMedications(activeMeds, filters);
  const shownInactiveMeds = filterMedications(inactiveMeds, filters);
  const totalMatches = shownActiveMeds.length + shownInactiveMeds.length;

  return {
    categoryFilter,
    setCategoryFilter,
    searchText,
    setSearchText,
    searchInputRef,
    fromDay,
    setFromDay,
    toDay,
    setToDay,
    resetAllFilters,
    categoriesInUse,
    effectiveCategoryFilter,
    isFiltered,
    shownActiveMeds,
    shownInactiveMeds,
    totalMatches,
    medsArray,
  };
}
