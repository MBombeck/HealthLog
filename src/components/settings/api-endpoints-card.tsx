"use client";

import { Key } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";

/** The ingest endpoints a token reaches, with the header and a body sketch. */
export function ApiEndpointsCard() {
  const { t } = useTranslations();

  // Dual-render: <md gets a stacked card list, md+
  // keeps the original table. Mobile cards wrap inside their box and
  // never trigger horizontal scroll, mirroring the pattern from
  // `<ApiTokenOverviewSection>`. The endpoint catalogue is array-driven
  // so adding a row remains a one-line edit on both surfaces — which is
  // what the two measurement ingest rows below cost.
  const endpoints = [
    {
      method: "POST",
      path: "/api/ingest/medication",
      auth: "Authorization: Bearer hlk_...",
      example: `{ "medicationName": "...", "scheduledFor": "..." }`,
    },
    {
      method: "POST",
      path: "/api/measurements",
      auth: "Authorization: Bearer hlk_...",
      example: `{ "type": "WEIGHT", "value": 82.4, "measuredAt": "..." }`,
    },
    {
      method: "POST",
      path: "/api/measurements/batch",
      auth: "Authorization: Bearer hlk_...",
      example: `{ "entries": [ { "hkIdentifier": "...", "value": 1, ... } ] }`,
    },
    {
      method: "POST",
      path: "/api/workouts/batch",
      auth: "Authorization: Bearer hlk_...",
      example: `{ "workouts": [ { "sportType": "running", "startedAt": "...", "endedAt": "...", "externalId": "..." } ] }`,
    },
    {
      method: "POST",
      path: "/api/documents/inbound",
      auth: "Authorization: Bearer hlk_...",
      example: `multipart: file, title, documentDate, sourceSystem, sourceId`,
    },
  ];

  return (
    <SettingsCard>
      <SettingsCardHeader
        anchor="api-endpoints"
        icon={Key}
        title={t("settings.apiEndpointsTitle")}
        description={t("settings.apiEndpointsDescription")}
      />

      {/* Desktop table — verbatim layout for md+. */}
      <div className="border-border relative hidden overflow-x-auto rounded-lg border md:block">
        <table className="w-full min-w-[760px] text-xs md:min-w-0">
          <thead>
            <tr className="bg-muted/40 text-muted-foreground border-b">
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointMethod")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointPath")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointAuth")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointExample")}
              </th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((endpoint) => (
              <tr key={`${endpoint.method} ${endpoint.path}`}>
                <td className="px-3 py-2 font-medium">{endpoint.method}</td>
                <td className="px-3 py-2 font-mono">{endpoint.path}</td>
                <td className="px-3 py-2 font-mono">{endpoint.auth}</td>
                <td className="px-3 py-2 font-mono">{endpoint.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card list — each endpoint stacks its columns vertically
          with a labelled meta row. No horizontal scroll. */}
      <ul
        className="space-y-2 md:hidden"
        data-testid="settings-api-endpoints-mobile-list"
      >
        {endpoints.map((endpoint) => (
          <li
            key={`${endpoint.method} ${endpoint.path}`}
            className="bg-muted/30 border-border space-y-1.5 rounded-lg border p-3 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                {endpoint.method}
              </Badge>
              <code className="font-mono break-all">{endpoint.path}</code>
            </div>
            <div>
              <p className="text-muted-foreground text-xs tracking-wide uppercase">
                {t("settings.apiEndpointAuth")}
              </p>
              <code className="font-mono break-all">{endpoint.auth}</code>
            </div>
            <div>
              <p className="text-muted-foreground text-xs tracking-wide uppercase">
                {t("settings.apiEndpointExample")}
              </p>
              <code className="block font-mono break-all">
                {endpoint.example}
              </code>
            </div>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}
