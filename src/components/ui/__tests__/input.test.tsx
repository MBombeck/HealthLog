import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Input } from "../input";

describe("<Input>", () => {
  it("defaults autoComplete to off and tells password managers to skip", () => {
    const html = renderToStaticMarkup(<Input id="weight" />);
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('data-lpignore="true"');
    expect(html).toContain('data-1p-ignore="true"');
  });

  it("respects an explicit autoComplete value and drops the ignore attrs", () => {
    const html = renderToStaticMarkup(
      <Input id="email" type="email" autoComplete="email" />,
    );
    expect(html).toContain('autoComplete="email"');
    expect(html).not.toContain('data-lpignore="true"');
    expect(html).not.toContain('data-1p-ignore="true"');
  });

  it("explicit autoComplete=username keeps password manager active for login flows", () => {
    const html = renderToStaticMarkup(
      <Input id="username" autoComplete="username" />,
    );
    expect(html).toContain('autoComplete="username"');
    expect(html).not.toContain("lpignore");
    expect(html).not.toContain("1p-ignore");
  });
});
