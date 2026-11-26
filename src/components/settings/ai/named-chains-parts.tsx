"use client";

/* ────────────────────────────────────────────────────────────────
 * The pieces of the chains-per-task card (#1404): one chain's tile,
 * one entry row, the task list, and the egress labels. Presentational;
 * the card owns the draft and the save.
 * ──────────────────────────────────────────────────────────────── */

import { useId, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Cloud,
  HardDrive,
  PlusCircle,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useTranslations } from "@/lib/i18n/context";

import {
  NAMED_CHAIN_CAPABILITIES,
  type ChainProviderType,
  type NamedChainView,
  type NamedChainsData,
} from "./shared";

export type ProviderInfo = ReadonlyMap<
  string,
  NamedChainsData["providers"][number]
>;

type Egress = "local" | "external";

const ICON_BUTTON = "min-h-11 min-w-11 sm:min-h-9 sm:min-w-9";

function swap<T>(list: readonly T[], a: number, b: number): T[] {
  if (b < 0 || b >= list.length) return [...list];
  const next = [...list];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/** Where an entry's input goes, as an icon and words. */
function EgressText({
  egress,
  name,
}: {
  egress: Egress;
  /** With a name, the words go to screen readers only. */
  name?: string;
}) {
  const { t } = useTranslations();
  const Icon = egress === "local" ? HardDrive : Cloud;
  const where = t(
    egress === "local"
      ? "settings.ai.namedChains.egressLocal"
      : "settings.ai.namedChains.egressExternal",
  );
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {name ? (
        <span>
          {name}
          <span className="sr-only">: {where}</span>
        </span>
      ) : (
        where
      )}
    </span>
  );
}

function EntryRow({
  type,
  index,
  count,
  providers,
  onMove,
  onRemove,
}: {
  type: ChainProviderType;
  index: number;
  count: number;
  providers: ProviderInfo;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslations();
  const info = providers.get(type);
  return (
    <li
      data-chain-entry={type}
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      <span className="text-muted-foreground w-5 text-center text-xs tabular-nums">
        {index + 1}.
      </span>
      <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-0">
        <p className="text-sm font-medium">
          {t(`settings.ai.providerChain.types.${type}`)}
        </p>
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
          <EgressText egress={info?.egress ?? "external"} />
          {!info?.available && (
            <span>{t("settings.ai.namedChains.notSetUp")}</span>
          )}
        </p>
      </div>
      {/* A lone entry can be neither moved nor removed, so its three
          disabled buttons were a whole row of nothing. */}
      {count > 1 && (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t("settings.ai.providerChain.moveUp")}
            disabled={index === 0}
            onClick={() => onMove(-1)}
            className={ICON_BUTTON}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t("settings.ai.providerChain.moveDown")}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            className={ICON_BUTTON}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t("settings.ai.providerChain.removeFromChain")}
            onClick={onRemove}
            className={`text-destructive ${ICON_BUTTON}`}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
    </li>
  );
}

function AddEntry({
  options,
  onAdd,
}: {
  options: readonly ChainProviderType[];
  onAdd: (type: ChainProviderType) => void;
}) {
  const { t } = useTranslations();
  const [picked, setPicked] = useState<string>("");
  if (options.length === 0) return null;
  const value = options.find((option) => option === picked) ?? options[0]!;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label={t("settings.ai.providerChain.addProvider")}
        value={value}
        onChange={(e) => setPicked(e.target.value)}
        className="w-auto"
      >
        {options.map((type) => (
          <option key={type} value={type}>
            {t(`settings.ai.providerChain.types.${type}`)}
          </option>
        ))}
      </NativeSelect>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="min-h-11 sm:min-h-9"
        onClick={() => onAdd(value)}
      >
        <PlusCircle className="h-4 w-4" />
        {t("settings.ai.providerChain.addProvider")}
      </Button>
    </div>
  );
}

/** One named chain: its name, default marker, delete, and its entries. */
export function ChainTile({
  chain,
  isDefault,
  usedBy,
  providers,
  onChange,
  onMakeDefault,
  onDelete,
}: {
  chain: NamedChainView;
  isDefault: boolean;
  /** How many tasks are attached to it. */
  usedBy: number;
  providers: ProviderInfo;
  onChange: (next: NamedChainView) => void;
  onMakeDefault: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslations();
  const setEntries = (entries: ChainProviderType[]) =>
    onChange({ ...chain, entries });
  // The server's shared ChatGPT is offered only where it can answer.
  const addable = [...providers.values()]
    .filter(
      (p) =>
        !chain.entries.includes(p.providerType) &&
        (p.available || p.providerType !== "admin-codex"),
    )
    .map((p) => p.providerType);

  return (
    <li
      data-named-chain={chain.id}
      className="border-border space-y-3 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={chain.name}
          maxLength={40}
          aria-label={t("settings.ai.namedChains.nameLabel")}
          onChange={(e) => onChange({ ...chain, name: e.target.value })}
          className="min-w-0 flex-1 basis-40"
        />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isDefault ? (
            <Badge variant="secondary">
              {t("settings.ai.namedChains.defaultBadge")}
            </Badge>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              onClick={onMakeDefault}
            >
              <Star className="h-4 w-4" />
              {t("settings.ai.namedChains.makeDefault")}
            </Button>
          )}
          <ConfirmButton
            label=""
            ariaLabel={t("settings.ai.namedChains.deleteChain")}
            title={t("settings.ai.namedChains.deleteConfirmTitle", {
              name: chain.name.trim() || "…",
            })}
            body={
              usedBy > 0 || isDefault
                ? t("settings.ai.namedChains.deleteConfirmBodyUsed", {
                    count: usedBy,
                  })
                : t("settings.ai.namedChains.deleteConfirmBody")
            }
            confirmLabel={t("settings.ai.namedChains.deleteChain")}
            onConfirm={onDelete}
            size="icon"
            className={`text-destructive ${ICON_BUTTON}`}
            icon={<Trash2 className="h-4 w-4" />}
            destructive
          />
        </div>
      </div>

      <ol className="space-y-2">
        {chain.entries.map((type, idx) => (
          <EntryRow
            key={type}
            type={type}
            index={idx}
            count={chain.entries.length}
            providers={providers}
            onMove={(delta) =>
              setEntries(swap(chain.entries, idx, idx + delta))
            }
            onRemove={() =>
              setEntries(chain.entries.filter((_, i) => i !== idx))
            }
          />
        ))}
      </ol>

      {chain.entries.length === 1 && (
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.namedChains.bindingHint")}
        </p>
      )}

      <AddEntry
        options={addable}
        onAdd={(type) => setEntries([...chain.entries, type])}
      />
    </li>
  );
}

/**
 * Every task and the chain it follows.
 *
 * The providers a chain tries are listed only under a task that follows a
 * named chain: repeating the default chain under every task stacked about a
 * dozen identical lines. Until a chain exists there is nothing to choose, so
 * one sentence says so instead of a column of disabled selects.
 */
export function TaskList({
  chains,
  attachments,
  providers,
  onAttach,
}: {
  chains: readonly NamedChainView[];
  attachments: Readonly<Record<string, string>>;
  providers: ProviderInfo;
  onAttach: (capability: string, chainId: string) => void;
}) {
  const { t } = useTranslations();
  return (
    <>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {t("settings.ai.namedChains.tasksHeading")}
        </h3>
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.namedChains.tasksHint")}
        </p>
      </div>
      {chains.length === 0 ? (
        <p
          className="text-muted-foreground text-xs"
          data-slot="named-chain-tasks-empty"
        >
          {t("settings.ai.namedChains.tasksNeedChain")}
        </p>
      ) : (
        <ul className="divide-border divide-y" data-slot="named-chain-tasks">
          {NAMED_CHAIN_CAPABILITIES.map((capability) => {
            const label = t(
              `settings.ai.namedChains.capabilities.${capability}`,
            );
            const attached = chains.find(
              (c) => c.id === attachments[capability],
            );
            // A bound task reads only its chain. With nothing in it set up
            // the task does not run, and its action is withheld wherever it
            // would appear, so this row is where to say why (#1404).
            const unusable =
              attached !== undefined &&
              !attached.entries.some((type) => providers.get(type)?.available);

            return (
              <li
                key={capability}
                data-capability={capability}
                className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1 basis-48">
                  <p className="text-sm font-medium">{label}</p>
                  {attached ? (
                    <ul className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {attached.entries.map((type) => (
                        <li key={type}>
                          <EgressText
                            egress={providers.get(type)?.egress ?? "external"}
                            name={t(`settings.ai.providerChain.types.${type}`)}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {attached && !unusable && attached.entries.length === 1 && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t("settings.ai.namedChains.bindingShort")}
                    </p>
                  )}
                  {unusable && (
                    <p
                      className="text-muted-foreground mt-1 text-xs"
                      data-slot="named-chain-task-no-provider"
                    >
                      {t("settings.ai.namedChains.taskNoProvider")}
                    </p>
                  )}
                </div>
                <NativeSelect
                  aria-label={label}
                  value={attached?.id ?? ""}
                  onChange={(e) => onAttach(capability, e.target.value)}
                  className="w-full sm:w-48"
                >
                  <option value="">
                    {t("settings.ai.namedChains.taskDefault")}
                  </option>
                  {chains.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name.trim() || "…"}
                    </option>
                  ))}
                </NativeSelect>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Which chain Default means: the fallback chain or one of the named ones. */
export function DefaultChainSelect({
  chains,
  value,
  onChange,
}: {
  chains: readonly NamedChainView[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const { t } = useTranslations();
  const id = useId();
  return (
    <FieldGroup
      htmlFor={id}
      label={t("settings.ai.namedChains.defaultChainLabel")}
      hint={t("settings.ai.namedChains.defaultChainHint")}
    >
      <NativeSelect
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full sm:w-64"
      >
        <option value="">{t("settings.ai.providerChain.title")}</option>
        {chains.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name.trim() || "…"}
          </option>
        ))}
      </NativeSelect>
    </FieldGroup>
  );
}
