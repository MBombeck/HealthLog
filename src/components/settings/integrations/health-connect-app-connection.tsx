"use client";

/**
 * Settings → Integrations → the Android devices running HealthLog Sync.
 *
 * One group: a row per paired device (its model and when it last reached the
 * server, with Disconnect), and a row that opens the pairing sheet. The sheet
 * mints a one-time code (`POST /api/health-connect/pairing`, behind the
 * recent-proof gate) and shows it as a QR code holding the deep link the app
 * opens. The code lives ten minutes; "New code" mints another. No prose: the
 * app says what to do with the code.
 *
 * Disconnecting deletes the device (`DELETE /api/auth/me/devices/{id}`),
 * which revokes the token it was paired with.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { ListGroup, ListItem } from "@/components/ui/list-row";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SourceIcon } from "@/components/settings/import-panel/import-card-shell";
import {
  recentProofErrorMessage,
  throwIfReproofRequired,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
import { apiDelete, apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { CONFIRMS_INLINE } from "@/lib/api/mutation-feedback";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface DeviceRow {
  id: string;
  label: string;
  platform: string;
  lastSeenAt: string;
}

interface Pairing {
  code: string;
  expiresAt: string;
  link: string;
  /** The link as an SVG data URL, drawn here. */
  qr: string;
}

async function drawQr(link: string): Promise<string> {
  // Loaded on open only: nothing else on the page draws a QR code.
  const QRCode = (await import("qrcode")).default;
  const svg = await QRCode.toString(link, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
  });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function HealthConnectAppConnection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const recentProof = useRecentProof();
  const [open, setOpen] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const devices = useQuery({
    queryKey: queryKeys.authDevices(),
    queryFn: () => apiGet<{ devices: DeviceRow[] }>("/api/auth/me/devices"),
    select: (data) => data.devices.filter((d) => d.platform === "android"),
  });

  const disconnect = useMutation({
    mutationKey: queryKeys.authDevices(),
    mutationFn: (id: string) =>
      apiDelete(`/api/auth/me/devices/${encodeURIComponent(id)}`),
    // The device's row leaves the list; that is the answer.
    meta: CONFIRMS_INLINE,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.authDevices() }),
  });

  async function mint() {
    setMinting(true);
    setError(null);
    try {
      const res = await recentProof.run(async () =>
        throwIfReproofRequired(
          await apiFetchRaw("/api/health-connect/pairing", { method: "POST" }),
        ),
      );
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || t("common.networkError"));
        return;
      }
      const data = json.data as Omit<Pairing, "qr">;
      setPairing({ ...data, qr: await drawQr(data.link) });
    } catch (err) {
      setError(recentProofErrorMessage(err, t("common.networkError")));
    } finally {
      setMinting(false);
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && !pairing) void mint();
    if (!next) {
      // A code is shown once; closing the sheet lets it go, and the device
      // list picks up a phone that paired meanwhile.
      setPairing(null);
      setError(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.authDevices(),
      });
    }
  }

  const title = t("settings.healthConnectApp.connect");
  return (
    <div data-testid="health-connect-app">
      <ListGroup>
        {devices.isError ? (
          <li>
            <QueryErrorRow
              inset
              error={devices.error}
              onRetry={() => void devices.refetch()}
            />
          </li>
        ) : null}
        {(devices.data ?? []).map((device) => (
          <ListItem
            key={device.id}
            data-testid="health-connect-app-device"
            icon={<SourceIcon icon={Smartphone} />}
            title={device.label}
            meta={fmt.dateTime(device.lastSeenAt)}
            trailing={
              <ConfirmButton
                size="sm"
                className="relative z-10"
                label={t("settings.healthConnectApp.disconnect")}
                title={t("settings.healthConnectApp.disconnectTitle", {
                  device: device.label,
                })}
                body={t("settings.healthConnectApp.disconnectBody")}
                confirmLabel={t("settings.healthConnectApp.disconnect")}
                pending={disconnect.isPending}
                destructive
                testId="health-connect-app-disconnect"
                onConfirm={() => disconnect.mutate(device.id)}
              />
            }
          />
        ))}
        <ListItem
          data-testid="health-connect-app-connect"
          icon={<SourceIcon icon={Plus} />}
          title={title}
          meta={t("settings.healthConnectApp.preview")}
          onSelect={() => onOpenChange(true)}
        />
      </ListGroup>
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        footer={
          <Button
            type="button"
            disabled={minting}
            data-testid="health-connect-app-new-code"
            onClick={() => void mint()}
          >
            {t("settings.healthConnectApp.newCode")}
          </Button>
        }
      >
        <div
          data-testid="health-connect-app-sheet"
          className="flex flex-col items-center gap-3"
        >
          {pairing ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL drawn here, nothing to optimise */}
              <img
                src={pairing.qr}
                alt={t("settings.healthConnectApp.qrAlt")}
                data-testid="health-connect-app-qr"
                className="bg-background size-56 rounded-lg"
              />
              <p className="text-muted-foreground text-sm">
                {t("settings.healthConnectApp.validUntil", {
                  time: fmt.time(pairing.expiresAt),
                })}
              </p>
            </>
          ) : error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : (
            <Loader2
              className="text-muted-foreground size-6 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
        </div>
      </ResponsiveSheet>
      {recentProof.dialog}
    </div>
  );
}
