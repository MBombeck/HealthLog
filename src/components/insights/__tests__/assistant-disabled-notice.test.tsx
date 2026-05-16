import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { AssistantDisabledNotice } from "../assistant-disabled-notice";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<AssistantDisabledNotice>", () => {
  it("renders the coach copy in the card variant", () => {
    const html = render(<AssistantDisabledNotice surface="coach" />);
    expect(html).toContain("data-slot=\"assistant-disabled-notice\"");
    expect(html.toLowerCase()).toContain("coach");
  });

  it("renders the briefing copy", () => {
    const html = render(<AssistantDisabledNotice surface="briefing" />);
    expect(html).toContain("data-slot=\"assistant-disabled-notice\"");
  });

  it("renders the status copy", () => {
    const html = render(<AssistantDisabledNotice surface="insightStatus" />);
    expect(html).toContain("data-slot=\"assistant-disabled-notice\"");
  });

  it("renders the inline variant without the Card wrapper", () => {
    const html = render(
      <AssistantDisabledNotice surface="correlations" variant="inline" />,
    );
    expect(html).toContain("<p");
    expect(html).not.toContain("CardContent");
  });
});
