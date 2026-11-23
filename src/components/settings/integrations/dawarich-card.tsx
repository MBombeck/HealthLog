"use client";

// Dawarich movement context. Like Nightscout it is an address and a key the
// self-hoster pastes once; unlike it, it only ever reads daily values (how
// far, by car or train, how long away from home, which country) and never a
// coordinate. The card reads the consolidated envelope for `health`, and the
// Dawarich status route for what only this card shows: the home place, the
// home country and how many days are stored. It belongs to the environment
// module and is not shown while that module is off.

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  KeyRound,
  Link2,
  Loader2,
  MapPinned,
  Plug,
  RefreshCw,
  Trash2,
  Unlink,
} from "lucide-react";
import { toast } from "sonner";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PasswordInput } from "@/components/ui/password-input";
import { TagChip } from "@/components/ui/tag-chip";
import { ApiError, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import type { ConnectionHealth } from "@/lib/integrations/connection-health";
import { queryKeys } from "@/lib/query-keys";

import { ActionResultLines, useConnectionTest } from "./integration-actions";
import {
  IntegrationCard,
  type IntegrationMenuAction,
} from "./integration-card";
import {
  IntegrationCardDescription,
  integrationDocsHref,
} from "./setup-guide-link";
import type { IntegrationStatusViewModel } from "./shared";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { InlineAction } from "@/components/ui/inline-action";

interface DawarichStatus {
  connected: boolean;
  configured: boolean;
  homePlaceSet: boolean;
  homeCountry: string | null;
  daysStored: number;
  oldestDay: string | null;
  latestDay: string | null;
  health: ConnectionHealth | null;
}

/** Error codes the connect route answers, with the sentence each one gets. */
const CONNECT_ERROR_KEYS: Record<string, string> = {
  "dawarich.invalid": "settings.dawarichErrors.invalid",
  private_origin_not_approved: "settings.dawarichErrors.privateOrigin",
  "dawarich.credentials_rejected": "settings.dawarichErrors.credentials",
  "dawarich.unreachable": "settings.dawarichErrors.unreachable",
  "dawarich.rate_limited": "settings.dawarichErrors.rateLimited",
  "dawarich.home_place_unknown": "settings.dawarichErrors.homePlaceUnknown",
  "dawarich.not_connected": "settings.dawarichErrors.notConnected",
};

function errorKeyOf(error: unknown): string {
  const code =
    error instanceof ApiError && typeof error.meta?.errorCode === "string"
      ? error.meta.errorCode
      : null;
  return (
    (code && CONNECT_ERROR_KEYS[code]) ?? "settings.dawarichErrors.generic"
  );
}

export function DawarichCard({
  viewModel,
}: {
  viewModel?: IntegrationStatusViewModel;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const connected = viewModel?.connected ?? false;
  const test = useConnectionTest("/api/dawarich/test");
  const [editing, setEditing] = useState(false);
  const [homeEditing, setHomeEditing] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.integrationsStatus() });
    queryClient.invalidateQueries({ queryKey: queryKeys.dawarichStatus() });
  };

  const sync = useMutation({
    mutationFn: () => apiPost<{ enqueued: boolean }>("/api/dawarich/sync", {}),
    onSuccess: (result) => {
      toast.success(
        t(
          result.enqueued
            ? "settings.dawarichSyncQueued"
            : "settings.dawarichSyncAlreadyQueued",
        ),
      );
      refresh();
    },
    onError: (error) => showErrorToast(t(errorKeyOf(error)), { cause: error }),
  });

  const disconnect = useMutation({
    mutationFn: (deleteData: boolean) =>
      apiPost("/api/dawarich/disconnect", { deleteData }),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: queryKeys.environment() });
    },
    onError: (error) =>
      showErrorToast(t("settings.dawarichErrors.generic"), { cause: error }),
  });

  function openForm() {
    setEditing(true);
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      formRef.current
        ?.querySelector<HTMLInputElement>("#dawarich-url")
        ?.focus();
    });
  }

  const form = (
    <DawarichForm
      formRef={formRef}
      connected={connected}
      onConnected={() => {
        setEditing(false);
        refresh();
      }}
    />
  );

  if (!connected) {
    return (
      <IntegrationCard
        provider="dawarich"
        providerName={t("settings.dawarich")}
        icon={MapPinned}
        titleAccessory={<TagChip>{t("settings.dawarichTag")}</TagChip>}
        description={
          <IntegrationCardDescription
            i18nPrefix="settings.dawarich"
            provider="dawarich"
          />
        }
        loading={viewModel === undefined}
        connected={false}
        health={null}
        setup={form}
      />
    );
  }

  const menu: IntegrationMenuAction[] = [
    {
      id: "sync",
      label: t("settings.dawarichSync"),
      icon: RefreshCw,
      disabled: sync.isPending,
      onSelect: () => sync.mutate(),
    },
    {
      id: "test",
      label: t("settings.testConnection.test"),
      icon: Plug,
      disabled: test.testing,
      onSelect: test.run,
    },
    {
      id: "home",
      label: t("settings.dawarichHomePlaceChange"),
      icon: MapPinned,
      onSelect: () => setHomeEditing(true),
    },
    {
      id: "credentials",
      label: t("settings.integrationCard.menu.address"),
      icon: KeyRound,
      onSelect: () => setEditing((open) => !open),
    },
    {
      id: "setup-guide",
      label: t("settings.integrationSetupGuide"),
      icon: BookOpen,
      href: integrationDocsHref("dawarich"),
      external: true,
    },
    {
      id: "disconnect",
      label: t("settings.dawarichDisconnect"),
      icon: Unlink,
      destructive: true,
      onSelect: () => disconnect.mutate(false),
      confirm: {
        title: t("settings.dawarichDisconnectTitle"),
        body: t("settings.dawarichDisconnectDescription"),
        confirmLabel: t("settings.dawarichDisconnect"),
      },
    },
    {
      id: "disconnect-delete",
      label: t("settings.dawarichDisconnectDelete"),
      icon: Trash2,
      destructive: true,
      onSelect: () => disconnect.mutate(true),
      confirm: {
        title: t("settings.dawarichDisconnectDeleteTitle"),
        body: t("settings.dawarichDisconnectDeleteDescription"),
        confirmLabel: t("settings.dawarichDisconnectDelete"),
      },
    },
  ];

  return (
    <IntegrationCard
      provider="dawarich"
      providerName={t("settings.dawarich")}
      icon={MapPinned}
      titleAccessory={<TagChip>{t("settings.dawarichTag")}</TagChip>}
      connected
      health={viewModel?.health ?? null}
      primary={{ onReconnect: openForm, onResume: openForm }}
      menu={menu}
    >
      <DawarichHome editing={homeEditing} onEditingChange={setHomeEditing} />
      <ActionResultLines provider="dawarich" test={test} />
      {editing ? form : null}
    </IntegrationCard>
  );
}

/**
 * The home place and home country, and what is stored.
 *
 * The editor is closed by default and opens from the card menu (or from the
 * prompt when nothing is set yet), like the address form beside it. Open, it
 * carries its own Cancel and Save; closed, the card has exactly one action
 * row, its own, at the bottom (UI standards §12). It used to show the
 * country field and a second always-on row of buttons above the card's.
 */
function DawarichHome({
  editing,
  onEditingChange,
}: {
  editing: boolean;
  onEditingChange: (open: boolean) => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.dawarichStatus(),
    queryFn: () => apiGet<DawarichStatus>("/api/dawarich/status"),
  });
  const [placeId, setPlaceId] = useState("");
  const [country, setCountry] = useState("");
  const places = useQuery({
    queryKey: queryKeys.dawarichPlaces(""),
    queryFn: () =>
      apiGet<{ places: Array<{ id: number; name: string }> }>(
        "/api/dawarich/places",
      ),
    enabled: editing,
  });

  const save = useMutation({
    mutationFn: (body: {
      homePlaceId?: number | null;
      homeCountry?: string | null;
    }) => apiPatch("/api/dawarich/settings", body),
    onSuccess: () => {
      toast.success(t("settings.dawarichHomeSaved"));
      onEditingChange(false);
      setPlaceId("");
      setCountry("");
      queryClient.invalidateQueries({ queryKey: queryKeys.dawarichStatus() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.environmentTravelSuggestions(),
      });
    },
    onError: (error) => showErrorToast(t(errorKeyOf(error)), { cause: error }),
  });

  const data = status.data;
  if (!data) return null;
  const countryValue = country.trim().toUpperCase();

  return (
    <div className="space-y-3" data-slot="dawarich-home">
      <p className="text-sm">
        {data.homePlaceSet
          ? t("settings.dawarichHomePlaceSet")
          : t("settings.dawarichHomePlaceMissing")}{" "}
        {data.homeCountry
          ? t("settings.dawarichHomeCountryIs", { country: data.homeCountry })
          : t("settings.dawarichHomeCountryMissing")}
      </p>
      <p className="text-muted-foreground text-xs">
        {t("settings.dawarichDaysStored", { count: data.daysStored })}
      </p>
      {!editing && (!data.homePlaceSet || !data.homeCountry) ? (
        <InlineAction
          onClick={() => onEditingChange(true)}
          data-testid="dawarich-pick-home"
        >
          <MapPinned aria-hidden="true" />
          {t("settings.dawarichHomePlaceChange")}
        </InlineAction>
      ) : null}
      {editing ? (
        <div className="space-y-3" data-slot="dawarich-home-editor">
          <div className="space-y-1.5">
            <Label htmlFor="dawarich-home-place">
              {t("settings.dawarichHomePlace")}
            </Label>
            {places.isError ? (
              <QueryErrorRow
                inset
                error={places.error}
                slot="dawarich-places-error"
                message={t(errorKeyOf(places.error))}
                onRetry={() => void places.refetch()}
              />
            ) : (
              <NativeSelect
                id="dawarich-home-place"
                value={placeId}
                disabled={places.isLoading}
                onChange={(e) => setPlaceId(e.target.value)}
              >
                <option value="">
                  {t("settings.dawarichHomePlaceChoose")}
                </option>
                {(places.data?.places ?? []).map((place) => (
                  <option key={place.id} value={String(place.id)}>
                    {place.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dawarich-home-country" className="flex">
              {t("settings.dawarichHomeCountry")}
            </Label>
            <Input
              id="dawarich-home-country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder={data.homeCountry ?? "DE"}
              maxLength={2}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="w-24"
            />
            <p className="text-muted-foreground text-xs">
              {t("settings.dawarichHomeCountryHelp")}
            </p>
          </div>
          <SettingsCardActions>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onEditingChange(false)}
              data-testid="dawarich-cancel-home"
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                save.isPending ||
                (placeId === "" && !/^[A-Z]{2}$/.test(countryValue))
              }
              onClick={() =>
                save.mutate({
                  ...(placeId !== "" ? { homePlaceId: Number(placeId) } : {}),
                  ...(/^[A-Z]{2}$/.test(countryValue)
                    ? { homeCountry: countryValue }
                    : {}),
                })
              }
              data-testid="dawarich-save-home"
            >
              {save.isPending ? (
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("settings.dawarichHomeSave")}
            </Button>
          </SettingsCardActions>
        </div>
      ) : null}
    </div>
  );
}

function DawarichForm({
  formRef,
  connected,
  onConnected,
}: {
  formRef: React.RefObject<HTMLFormElement | null>;
  connected: boolean;
  onConnected: () => void;
}) {
  const { t } = useTranslations();
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const connect = useMutation({
    mutationFn: () =>
      apiPost("/api/dawarich/connect", {
        url: url.trim(),
        apiKey: apiKey.trim(),
      }),
    onSuccess: () => {
      setApiKey("");
      toast.success(t("settings.dawarichConnected"));
      onConnected();
    },
  });

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        connect.mutate();
      }}
      className="space-y-3"
      data-testid="dawarich-form"
    >
      <div className="space-y-1.5">
        <Label htmlFor="dawarich-url">{t("settings.dawarichUrl")}</Label>
        <Input
          id="dawarich-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://dawarich.example.com"
          maxLength={2048}
          autoComplete="off"
          inputMode="url"
          spellCheck={false}
          autoCapitalize="none"
          enterKeyHint="next"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="dawarich-api-key">{t("settings.dawarichApiKey")}</Label>
        <PasswordInput
          id="dawarich-api-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          maxLength={512}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          enterKeyHint="done"
        />
        <p className="text-muted-foreground text-xs">
          {t("settings.dawarichApiKeyHelp")}
        </p>
      </div>
      {connect.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {t(errorKeyOf(connect.error))}
        </p>
      ) : null}
      <SettingsCardActions>
        <Button
          type="submit"
          size="sm"
          variant={connected ? "outline" : "default"}
          disabled={connect.isPending || !url.trim() || !apiKey.trim()}
          data-slot={connected ? undefined : "integration-primary-action"}
          data-action={connected ? undefined : "connect"}
          data-testid="dawarich-connect"
        >
          {connect.isPending ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : connected ? null : (
            <Link2 className="size-3.5" aria-hidden="true" />
          )}
          {connected
            ? t("settings.dawarichUpdate")
            : t("settings.dawarichConnect")}
        </Button>
      </SettingsCardActions>
    </form>
  );
}
