"use client";

/**
 * Settings cards rendered inside a sheet.
 *
 * An integration opens as a sheet that already names it and states its
 * status, so the card that holds its setup form must not paint a second frame
 * and a second title inside it. The sheet sets `SheetCardContext`; a
 * `SettingsCard` under it renders as a plain column and its header either
 * disappears (`hide-header`, the card the sheet is about) or shrinks to a
 * subheading (`subheading`, a further card in the same sheet).
 *
 * `IntegrationSheetSlotsContext` hands an `IntegrationCard` the two places the
 * sheet keeps for it: the action row at the foot of the body and the ⋯ menu
 * beside the title.
 */
import { createContext, useContext } from "react";

export type SheetCardMode = "hide-header" | "subheading";

export const SheetCardContext = createContext<SheetCardMode | null>(null);

export function useSheetCardMode(): SheetCardMode | null {
  return useContext(SheetCardContext);
}

export interface IntegrationSheetSlots {
  /** The action row at the foot of the sheet body. */
  actions: HTMLElement | null;
  /** Beside the sheet title, for the ⋯ menu. */
  menu: HTMLElement | null;
}

export const IntegrationSheetSlotsContext =
  createContext<IntegrationSheetSlots | null>(null);

export function useIntegrationSheetSlots(): IntegrationSheetSlots | null {
  return useContext(IntegrationSheetSlotsContext);
}
