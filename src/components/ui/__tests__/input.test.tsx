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

  it("derives inputMode=decimal from type=number", () => {
    const html = renderToStaticMarkup(<Input id="weight" type="number" />);
    expect(html).toContain('inputMode="decimal"');
  });

  it("derives inputMode=email from type=email", () => {
    const html = renderToStaticMarkup(
      <Input id="email" type="email" autoComplete="email" />,
    );
    expect(html).toContain('inputMode="email"');
  });

  it("derives inputMode=url from type=url", () => {
    const html = renderToStaticMarkup(<Input id="webhook" type="url" />);
    expect(html).toContain('inputMode="url"');
  });

  it("derives inputMode=tel from type=tel", () => {
    const html = renderToStaticMarkup(<Input id="phone" type="tel" />);
    expect(html).toContain('inputMode="tel"');
  });

  it("derives inputMode=search from type=search", () => {
    const html = renderToStaticMarkup(<Input id="filter" type="search" />);
    expect(html).toContain('inputMode="search"');
  });

  it("omits inputMode for plain text inputs", () => {
    const html = renderToStaticMarkup(<Input id="note" type="text" />);
    expect(html).not.toContain("inputMode=");
  });

  it("respects an explicit inputMode override on type=number", () => {
    const html = renderToStaticMarkup(
      <Input id="steps" type="number" inputMode="numeric" />,
    );
    expect(html).toContain('inputMode="numeric"');
    expect(html).not.toContain('inputMode="decimal"');
  });
});
