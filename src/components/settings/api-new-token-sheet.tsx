"use client";

/**
 * "New token" on Settings → API & tokens: one flow for every kind this page
 * mints (readings, workouts, documents). Name, access, how long it is valid,
 * then the token, shown once with a copy button.
 */

import { useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2 } from "lucide-react";

import {
  recentProofErrorMessage,
  throwIfReproofRequired,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field-group";
import { InlineAction } from "@/components/ui/inline-action";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SwitchRow } from "@/components/ui/switch-row";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

/** What the "New token" flow mints, with the endpoint behind each. */
const MINT_KINDS = {
  measurements: {
    labelKey: "settings.tokenList.scope.measurements",
    infoKey: "settings.tokenList.scopeInfo.measurements",
    placeholderKey: "settings.measurementsToken.namePlaceholder",
  },
  workouts: {
    labelKey: "settings.tokenList.scope.workouts",
    infoKey: "settings.tokenList.scopeInfo.workouts",
    placeholderKey: "settings.workoutsToken.namePlaceholder",
  },
  documents: {
    labelKey: "settings.tokenList.scope.documents",
    infoKey: "settings.tokenList.scopeInfo.documents",
    placeholderKey: "settings.documentsToken.namePlaceholder",
  },
} as const;
type MintKind = keyof typeof MINT_KINDS;

/**
 * The mint behind each kind, one route each. Run inside `recentProof.run`:
 * a token outlives the session, so minting one asks for a fresh proof unless
 * the session signed in or re-proved within five minutes.
 */
async function mint(kind: MintKind, body: string): Promise<Response> {
  const headers = { "Content-Type": "application/json" };
  switch (kind) {
    case "measurements":
      return throwIfReproofRequired(
        await apiFetchRaw("/api/tokens/measurements", {
          method: "POST",
          headers,
          body,
        }),
      );
    case "workouts":
      return throwIfReproofRequired(
        await apiFetchRaw("/api/tokens/workouts", {
          method: "POST",
          headers,
          body,
        }),
      );
    case "documents":
      return throwIfReproofRequired(
        await apiFetchRaw("/api/tokens/documents", {
          method: "POST",
          headers,
          body,
        }),
      );
  }
}

/** Expiry choices in days; the routes accept 1 to 365. */
const EXPIRY_DAYS = [30, 90, 180, 365] as const;

/** "More": at most two sentences, opened on tap. */
function MoreInfo({ children, label }: { children: string; label: string }) {
  const { t } = useTranslations();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <InlineAction tone="muted" size="sm" aria-label={label}>
          {t("settings.tokenList.more")}
        </InlineAction>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="max-w-xs">
        <p className="text-sm">{children}</p>
      </PopoverContent>
    </Popover>
  );
}

/** A copy button with its own announced outcome (`role="status"`). */
export function CopyValueButton({
  value,
  label,
  testId,
}: {
  value: string;
  /** Names what is copied, for screen readers. */
  label: string;
  testId?: string;
}) {
  const { t } = useTranslations();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  async function copy() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <span className="relative inline-flex shrink-0 items-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-9"
        aria-label={label}
        onClick={() => void copy()}
        data-state={state}
        data-testid={testId}
      >
        {state === "copied" ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        {state === "copied" ? t("settings.tokenList.copied") : t("common.copy")}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied"
          ? t("settings.tokenList.copied")
          : state === "failed"
            ? t("settings.tokenCopyFailed")
            : ""}
      </span>
    </span>
  );
}

/** The API address once, with copy, and the reference. */

/** Name, access, expiry; then the token, shown once. */
export function NewTokenSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const recentProof = useRecentProof();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MintKind>("measurements");
  const [days, setDays] = useState<number>(365);
  const [mirror, setMirror] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const formId = useId();

  function reset() {
    setName("");
    setKind("measurements");
    setDays(365);
    setMirror(false);
    setError(null);
    setToken(null);
  }

  function close() {
    onOpenChange(false);
    reset();
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const body = JSON.stringify({
        name: name.trim(),
        expiresInDays: days,
        ...(kind === "measurements" && { mirrorToAppleHealth: mirror }),
      });
      const res = await recentProof.run(async () => mint(kind, body));
      const json = await res.json();
      if (res.ok) {
        setToken(json.data.token);
        void queryClient.invalidateQueries({ queryKey: queryKeys.tokens() });
      } else {
        setError(json.error || t("settings.tokenList.create.failed"));
      }
    } catch (failure) {
      setError(recentProofErrorMessage(failure, t("common.networkError")));
    } finally {
      setCreating(false);
    }
  }

  const created = token !== null;

  return (
    <>
      {recentProof.dialog}
      <ResponsiveSheet
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : close())}
        title={
          created
            ? t("settings.tokenList.create.createdTitle")
            : t("settings.tokenList.newToken")
        }
        dirty={!created && name.trim().length > 0}
        footer={
          created ? (
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={close}
            >
              {t("settings.tokenList.create.done")}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={close}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                form={formId}
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={creating || !name.trim()}
                data-testid="api-new-token-create"
              >
                {creating ? (
                  <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                ) : null}
                {t("common.create")}
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div className="space-y-3" data-slot="settings-token-created">
            <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <code
                className="min-w-0 flex-1 font-mono text-sm break-all"
                data-testid="api-new-token-value"
              >
                {token}
              </code>
              <CopyValueButton
                value={token}
                label={t("settings.tokenCopy")}
                testId="api-new-token-copy"
              />
            </div>
            <p className="text-muted-foreground text-sm">
              {t("settings.tokenList.create.shownOnce")}
            </p>
          </div>
        ) : (
          <NewTokenFields
            formId={formId}
            onSubmit={(event) => void create(event)}
            name={name}
            onName={setName}
            kind={kind}
            onKind={setKind}
            days={days}
            onDays={setDays}
            mirror={mirror}
            onMirror={setMirror}
            error={error}
          />
        )}
      </ResponsiveSheet>
    </>
  );
}

/** The flow's first step: name, access, expiry and the write-back switch. */
function NewTokenFields({
  formId,
  onSubmit,
  name,
  onName,
  kind,
  onKind,
  days,
  onDays,
  mirror,
  onMirror,
  error,
}: {
  formId: string;
  onSubmit: (event: React.FormEvent) => void;
  name: string;
  onName: (value: string) => void;
  kind: MintKind;
  onKind: (value: MintKind) => void;
  days: number;
  onDays: (value: number) => void;
  mirror: boolean;
  onMirror: (value: boolean) => void;
  error: string | null;
}) {
  const { t } = useTranslations();
  return (
    <form
      id={formId}
      onSubmit={onSubmit}
      className="space-y-4"
      data-slot="api-new-token-form"
    >
      <FieldGroup
        htmlFor={`${formId}-name`}
        label={t("settings.tokenTableName")}
      >
        <Input
          id={`${formId}-name`}
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder={t(MINT_KINDS[kind].placeholderKey)}
          maxLength={100}
          autoComplete="off"
        />
      </FieldGroup>
      <FieldGroup
        htmlFor={`${formId}-scope`}
        label={t("settings.tokenList.scopeColumn")}
        labelAccessory={
          <MoreInfo label={t("settings.tokenList.scopeMoreLabel")}>
            {t(MINT_KINDS[kind].infoKey)}
          </MoreInfo>
        }
      >
        <NativeSelect
          id={`${formId}-scope`}
          value={kind}
          onChange={(e) => onKind(e.target.value as MintKind)}
          data-testid="api-new-token-scope"
        >
          {(Object.keys(MINT_KINDS) as MintKind[]).map((key) => (
            <option key={key} value={key}>
              {t(MINT_KINDS[key].labelKey)}
            </option>
          ))}
        </NativeSelect>
      </FieldGroup>
      <FieldGroup
        htmlFor={`${formId}-expiry`}
        label={t("settings.tokenList.create.expiry")}
      >
        <NativeSelect
          id={`${formId}-expiry`}
          value={String(days)}
          onChange={(e) => onDays(Number(e.target.value))}
        >
          {EXPIRY_DAYS.map((value) => (
            <option key={value} value={value}>
              {value === 365
                ? t("settings.tokenList.create.expiryYear")
                : t("settings.tokenList.create.expiryDays", {
                    days: value,
                  })}
            </option>
          ))}
        </NativeSelect>
      </FieldGroup>
      {kind === "measurements" ? (
        <SwitchRow
          id={`${formId}-mirror`}
          label={t("settings.measurementsToken.appleHealth.label")}
          checked={mirror}
          onCheckedChange={onMirror}
          data-slot="apple-health-mirror-opt-in"
          className="border-t pt-3"
        >
          <span className="ml-2">
            <MoreInfo label={t("settings.tokenList.mirrorMoreLabel")}>
              {t("settings.measurementsToken.appleHealth.createHint")}
            </MoreInfo>
          </span>
        </SwitchRow>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}
