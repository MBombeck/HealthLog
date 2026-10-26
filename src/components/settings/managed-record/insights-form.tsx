import type { FormEvent } from "react";

import { SUB_PAGE_TABS } from "@/components/insights/insights-tab-strip";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/lib/i18n/context";
import { normalizeInsightsTileId } from "@/lib/insights-layout";

import { INSIGHTS_SECTION_LABEL_KEYS } from "../managed-record-settings-labels";
import {
  asNumber,
  asRecord,
  asString,
  FormFooter,
  formNumber,
  ManagedSwitchRow,
  ownStringValue,
  type SettingsFormProps,
} from "./form-kit";

function insightItemLabel(
  t: ReturnType<typeof useTranslations>["t"],
  kind: "section" | "tile",
  id: string,
): string {
  if (kind === "section") {
    const labelKey = ownStringValue(INSIGHTS_SECTION_LABEL_KEYS, id);
    return labelKey
      ? t(labelKey)
      : t("settings.sharedRecord.managedSettings.insights.unknownItem");
  }

  const normalizedId = normalizeInsightsTileId(id);
  if (normalizedId === "overview") return t("insights.navOverview");
  if (!Object.hasOwn(SUB_PAGE_TABS, normalizedId)) {
    return t("settings.sharedRecord.managedSettings.insights.unknownItem");
  }

  const labelKey =
    SUB_PAGE_TABS[normalizedId as keyof typeof SUB_PAGE_TABS]?.labelKey;
  return typeof labelKey === "string"
    ? t(labelKey)
    : t("settings.sharedRecord.managedSettings.insights.unknownItem");
}

type LayoutItem = { id: string; visible: boolean; order: number };

function layoutItems(value: unknown): LayoutItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = asRecord(entry);
    const id = asString(item.id);
    return id
      ? [
          {
            id,
            visible: item.visible === true,
            order: asNumber(item.order, 0),
          },
        ]
      : [];
  });
}

export function InsightsSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();
  const layout = asRecord(settings.layout);
  const sections = layoutItems(layout.sections);
  const tiles = layoutItems(layout.tiles);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const toPatch = (kind: "section" | "tile", item: LayoutItem) => ({
      id: item.id,
      visible: form.get(`${kind}-visible-${item.id}`) === "on",
      order: formNumber(form, `${kind}-order-${item.id}`, item.order),
    });
    onSave({
      layout: {
        version: asNumber(layout.version, 2),
        sections: sections.map((section) => toPatch("section", section)),
        tiles: tiles.map((tile) => toPatch("tile", tile)),
      },
    });
  }

  const renderItems = (kind: "section" | "tile", items: LayoutItem[]) => (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {kind === "section"
          ? t("settings.sharedRecord.managedSettings.insights.sections")
          : t("settings.sharedRecord.managedSettings.insights.tiles")}
      </legend>
      {items.map((item) => (
        <div className="flex items-center gap-3 text-sm" key={item.id}>
          <ManagedSwitchRow
            className="flex flex-1 items-center justify-between gap-2 text-sm"
            name={`${kind}-visible-${item.id}`}
            label={insightItemLabel(t, kind, item.id)}
            defaultChecked={item.visible}
            disabled={disabled}
          />
          <label
            className="flex items-center gap-2"
            htmlFor={`${kind}-order-${item.id}`}
          >
            {t("settings.sharedRecord.managedSettings.insights.order")}
            <Input
              className="w-16"
              defaultValue={item.order}
              disabled={disabled}
              id={`${kind}-order-${item.id}`}
              min="0"
              name={`${kind}-order-${item.id}`}
              type="number"
            />
          </label>
        </div>
      ))}
    </fieldset>
  );

  return (
    <form className="space-y-4" onSubmit={submit}>
      {renderItems("section", sections)}
      {renderItems("tile", tiles)}
      <FormFooter disabled={disabled} label={saveLabel} error={error} />
    </form>
  );
}
