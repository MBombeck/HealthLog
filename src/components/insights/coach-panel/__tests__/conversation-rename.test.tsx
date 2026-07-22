import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import {
  ConversationRename,
  getConversationRenameKeyAction,
} from "../conversation-rename";

function renderRename() {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <ConversationRename id="c1" title="Morning check-in" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("ConversationRename", () => {
  it("renders a keyboard-focusable rename affordance with a localized label", () => {
    const html = renderRename();

    expect(html).toContain('data-slot="coach-conversation-rename"');
    expect(html).toContain('aria-label="Rename conversation"');
    expect(html).toContain('type="button"');
  });

  it("maps Enter to save and Escape to cancel without hijacking other keys", () => {
    expect(getConversationRenameKeyAction("Enter")).toBe("save");
    expect(getConversationRenameKeyAction("Escape")).toBe("cancel");
    expect(getConversationRenameKeyAction("a")).toBeNull();
  });
});
