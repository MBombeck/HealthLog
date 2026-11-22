import { useState, type FormEvent } from "react";

import { FieldGroup } from "@/components/ui/field-group";
import { NativeSelect } from "@/components/ui/native-select";
import { useTranslations } from "@/lib/i18n/context";

import {
  asRecord,
  asString,
  FormFooter,
  type SettingsFormProps,
} from "./form-kit";

/** One option value per choice: the source, plus the chain under GUARDIAN. */
const INSTANCE = "instance";
const NONE = "none";
const GUARDIAN_DEFAULT = "guardian:";

function optionOf(settings: Record<string, unknown>): string {
  const source = asString(settings.source, "INSTANCE");
  if (source === "NONE") return NONE;
  if (source === "GUARDIAN") {
    // Another guardian's chain is shown as what it is, not as one of yours.
    if (settings.servedByYou !== true) return "other";
    return `${GUARDIAN_DEFAULT}${asString(settings.chainId)}`;
  }
  return INSTANCE;
}

/**
 * #1403 — which provider the managed profile's AI work uses. The guardian
 * picks the operator's key, no provider, or one of their own chains. Their
 * own chain is served with their own credentials, so the copy says so before
 * the choice is saved.
 */
export function AiSourceSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();
  const chains = Array.isArray(settings.yourChains)
    ? settings.yourChains.map(asRecord)
    : [];
  const [choice, setChoice] = useState(optionOf(settings));
  const base = "settings.sharedRecord.managedSettings.aiSource";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (choice === "other") return;
    if (choice === INSTANCE) onSave({ source: "INSTANCE" });
    else if (choice === NONE) onSave({ source: "NONE" });
    else {
      const chainId = choice.slice(GUARDIAN_DEFAULT.length);
      onSave({ source: "GUARDIAN", chainId: chainId === "" ? null : chainId });
    }
  }

  const unusable =
    settings.source === "GUARDIAN" && settings.guardianChainUsable !== true;
  return (
    <form className="space-y-4" onSubmit={submit}>
      <p className="text-foreground text-sm">{t(`${base}.honesty`)}</p>
      <FieldGroup htmlFor="managed-ai-source" label={t(`${base}.label`)}>
        <NativeSelect
          value={choice}
          onChange={(event) => setChoice(event.currentTarget.value)}
          disabled={disabled}
          id="managed-ai-source"
          data-slot="managed-ai-source"
        >
          <option value={INSTANCE}>{t(`${base}.instance`)}</option>
          <option value={NONE}>{t(`${base}.none`)}</option>
          <option value={GUARDIAN_DEFAULT}>{t(`${base}.yourDefault`)}</option>
          {chains.map((chain) => (
            <option
              key={asString(chain.id)}
              value={`${GUARDIAN_DEFAULT}${asString(chain.id)}`}
            >
              {t(`${base}.yourChain`, { name: asString(chain.name) })}
            </option>
          ))}
          {choice === "other" ? (
            <option value="other" disabled>
              {t(`${base}.otherGuardian`)}
            </option>
          ) : null}
        </NativeSelect>
      </FieldGroup>
      {choice === INSTANCE && settings.instanceKeyConfigured !== true ? (
        <p className="text-muted-foreground text-xs">
          {t(`${base}.noInstanceKey`)}
        </p>
      ) : null}
      {choice.startsWith(GUARDIAN_DEFAULT) ? (
        <p className="text-muted-foreground text-xs">
          {t(`${base}.yourCredentials`)}
        </p>
      ) : null}
      {unusable ? (
        <p
          className="text-muted-foreground text-xs"
          data-slot="managed-ai-source-unusable"
        >
          {t(`${base}.unusable`)}
        </p>
      ) : null}
      <FormFooter
        disabled={disabled || choice === "other"}
        label={saveLabel}
        error={error}
      />
    </form>
  );
}
