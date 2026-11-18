import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { AntigravityProviderForm } from "../antigravity-provider-form";
import * as profileHook from "../use-antigravity-profile";

const mockUseAntigravityProfile = vi.spyOn(
  profileHook,
  "useAntigravityProfile",
);

describe("AntigravityProviderForm reasoning field disablement", () => {
  const baseProfile: ReturnType<typeof profileHook.useAntigravityProfile> = {
    status: {
      connectionStatus: "connected",
      connectedAt: "2026-11-01T10:00:00.000Z",
      cliInstalled: true,
      cliVersion: "1.5.10",
      canInstallCli: false,
      canUpdateCli: false,
      cliManaged: true,
      updateAvailable: false,
      latestVersion: "1.5.10",
      profileId: "prof-1",
      capabilities: null,
    },
    loading: false,
    loadFailed: false,
    busy: null,
    notice: null,
    connectOpen: false,
    models: {
      models: [{ id: "model-pro", name: "Model Pro" }],
      selectedModel: "model-pro",
      reason: null,
      thoughtLevels: ["low", "medium", "high"],
    },
    reasoning: "medium",
    antigravityEnabled: false,
    connected: true,
    openConnect: vi.fn(),
    closeConnect: vi.fn(),
    handleConnected: vi.fn(),
    test: vi.fn(),
    disconnect: vi.fn(),
    changeModel: vi.fn(),
    changeReasoning: vi.fn(),
    installCli: vi.fn(),
    updateCli: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables the reasoning select when Antigravity is absent or disabled in the provider chain", () => {
    mockUseAntigravityProfile.mockReturnValue({
      ...baseProfile,
      antigravityEnabled: false,
    });

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <AntigravityProviderForm />
      </I18nProvider>,
    );

    // The select element for Antigravity reasoning must be disabled
    expect(html).toContain('id="settings-ai-antigravity-reasoning"');
    expect(html).toMatch(
      /<select[^>]*id="settings-ai-antigravity-reasoning"[^>]*disabled=""/,
    );
  });

  it("enables the reasoning select when Antigravity is enabled in the provider chain", () => {
    mockUseAntigravityProfile.mockReturnValue({
      ...baseProfile,
      antigravityEnabled: true,
    });

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <AntigravityProviderForm />
      </I18nProvider>,
    );

    expect(html).toContain('id="settings-ai-antigravity-reasoning"');
    expect(html).not.toMatch(
      /<select[^>]*id="settings-ai-antigravity-reasoning"[^>]*disabled=""/,
    );
  });

  it("renders Disconnect with the same default button height/sizing as Update", () => {
    mockUseAntigravityProfile.mockReturnValue({
      ...baseProfile,
      connected: true,
      status: {
        ...baseProfile.status!,
        cliInstalled: true,
        canUpdateCli: true,
      },
    });

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <AntigravityProviderForm />
      </I18nProvider>,
    );

    // Both Disconnect (ConfirmButton trigger) and Update (Button) must use data-size="default", not size="sm"
    const disconnectBtn = html.match(
      /<button[^>]*data-slot="settings-ai-antigravity-disconnect"[^>]*>/,
    );
    expect(disconnectBtn).not.toBeNull();
    expect(disconnectBtn![0]).toContain('data-size="default"');
    expect(disconnectBtn![0]).not.toContain('data-size="sm"');

    // Update button is present with default size
    expect(html).toContain("Update Antigravity CLI");
    const updateBtn = html.match(
      /<button[^>]*data-size="default"[^>]*>(?:(?!<\/button>)[\s\S])*Update Antigravity CLI/,
    );
    expect(updateBtn).not.toBeNull();
  });

  it("renders Update button in immediate disabled pending/spinner state when busy is 'update'", () => {
    mockUseAntigravityProfile.mockReturnValue({
      ...baseProfile,
      busy: "update",
      status: {
        ...baseProfile.status!,
        cliInstalled: true,
        canUpdateCli: true,
      },
    });

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <AntigravityProviderForm />
      </I18nProvider>,
    );

    expect(html).toContain("Updating Antigravity CLI...");
    expect(html).toContain("animate-spin");
    const pendingBtn = html.match(/<button[^>]*aria-busy="true"[^>]*>/);
    expect(pendingBtn).not.toBeNull();
    expect(pendingBtn![0]).toContain('disabled=""');
  });

  it("removes the Update button when canUpdateCli is false", () => {
    mockUseAntigravityProfile.mockReturnValue({
      ...baseProfile,
      status: {
        ...baseProfile.status!,
        cliInstalled: true,
        canUpdateCli: false,
      },
    });

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <AntigravityProviderForm />
      </I18nProvider>,
    );

    expect(html).not.toContain("Update Antigravity CLI");
    expect(html).not.toContain("Updating Antigravity CLI...");
  });
});
