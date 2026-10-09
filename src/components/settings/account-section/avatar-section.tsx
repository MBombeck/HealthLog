"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ImageUp, Loader2, Trash2 } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { statusText, type StatusMessage } from "./account-section-utils";

// Accepted upload types + byte cap mirror the server contract in
// `src/app/api/user/avatar/route.ts` so the client rejects an obvious
// bad file before the round-trip. The server still re-validates by
// magic-byte sniff — this is a UX shortcut, not the security boundary.
const ACCEPTED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
const AVATAR_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

function getAvatarInitials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

export function AvatarSection() {
  const { t } = useTranslations();
  const { user, refetch } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<StatusMessage | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      const res = await apiFetchRaw("/api/user/avatar", {
        method: "POST",
        body,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 415)
          throw new Error(t("settings.avatar.invalidType"));
        if (res.status === 413) throw new Error(t("settings.avatar.tooLarge"));
        throw new Error(json.error || t("settings.avatar.error"));
      }
    },
    onSuccess: async () => {
      setMsgType("success");
      setMsg({ key: "settings.avatar.uploaded" });
      await refetch();
    },
    onError: (err: Error) => {
      setMsgType("error");
      setMsg({ text: err.message });
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await apiFetchRaw("/api/user/avatar", { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || t("settings.avatar.error"));
      }
    },
    onSuccess: async () => {
      setMsgType("success");
      setMsg({ key: "settings.avatar.removed" });
      await refetch();
    },
    onError: (err: Error) => {
      setMsgType("error");
      setMsg({ text: err.message });
    },
  });

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so re-selecting the same file still fires `onChange`.
    e.target.value = "";
    if (!file) return;
    setMsg(null);
    setMsgType(null);
    if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
      setMsgType("error");
      setMsg({ key: "settings.avatar.invalidType" });
      return;
    }
    if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
      setMsgType("error");
      setMsg({ key: "settings.avatar.tooLarge" });
      return;
    }
    upload.mutate(file);
  }

  if (!user) return null;
  const avatarUrl = user.avatarUrl ?? null;
  const busy = upload.isPending || remove.isPending;

  return (
    <SettingsCard>
      <SettingsCardHeader
        anchor="avatar"
        icon={ImageUp}
        title={t("settings.avatar.title")}
      />
      {/* The accepted formats and limits belong to the sentence that explains
          what this card does, not to a caption of their own under the buttons.
          Two strings rather than one merged key: the same wording is the
          upload's own constraint copy, and a translator keeps the shorter unit
          either way. */}
      <p className="text-sm">
        {t("settings.avatar.description")} {t("settings.avatar.hint")}
      </p>
      <div className="flex items-center gap-4">
        <Avatar className="size-16">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={user.username} />}
          <AvatarFallback className="text-base">
            {getAvatarInitials(user.username)}
          </AvatarFallback>
        </Avatar>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleFile}
          />
          <Button
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {upload.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <ImageUp className="h-4 w-4" />
            )}
            {avatarUrl
              ? t("settings.avatar.replace")
              : t("settings.avatar.upload")}
          </Button>
          {avatarUrl && (
            <ConfirmButton
              slot="settings-avatar-remove"
              variant="ghost"
              className="text-destructive min-h-11 sm:min-h-9"
              icon={<Trash2 className="h-4 w-4" />}
              label={t("settings.avatar.remove")}
              title={t("settings.avatar.removeTitle")}
              body={t("settings.avatar.removeBody")}
              confirmLabel={t("settings.avatar.removeConfirm")}
              disabled={busy && !remove.isPending}
              pending={remove.isPending}
              onConfirm={() => {
                setMsg(null);
                setMsgType(null);
                remove.mutate();
              }}
            />
          )}
        </div>
      </div>
      {msg && (
        <p
          role="alert"
          className={`text-sm ${
            msgType === "success" ? "text-success" : "text-destructive"
          }`}
        >
          {statusText(msg, t)}
        </p>
      )}
    </SettingsCard>
  );
}
