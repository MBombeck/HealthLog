import { describe, expect, it } from "vitest";

import {
  extractUmamiCollectPath,
  resolveUmamiSendUrls,
} from "@/lib/monitoring/umami";
import { UMAMI_PROXY_PREFIX } from "@/lib/monitoring/umami-paths";

/** The endpoint template of a built Umami tracker. */
function tracker(collectPath: string): string {
  return `const{currentScript:u}=c;const R=\`\${(x||""||u.src.split("/").slice(0,-1).join("/")).replace(/\\/$/,"")}${collectPath}\`,_=\`\${e}x\${a}\`;`;
}

describe("extractUmamiCollectPath", () => {
  it("reads Umami's default endpoint", () => {
    expect(extractUmamiCollectPath(tracker("/api/send"))).toBe("/api/send");
  });

  it("reads an endpoint renamed through COLLECT_API_ENDPOINT", () => {
    expect(extractUmamiCollectPath(tracker("/api/insight"))).toBe(
      "/api/insight",
    );
    expect(extractUmamiCollectPath(tracker("/collect"))).toBe("/collect");
  });

  it("falls back to the default for an unrecognised build", () => {
    expect(extractUmamiCollectPath("/* umami disabled */")).toBe("/api/send");
  });

  it("never accepts a traversal as the collect path", () => {
    expect(extractUmamiCollectPath(tracker("/../admin"))).toBe("/api/send");
  });
});

describe("resolveUmamiSendUrls", () => {
  it("tries the script directory, the host root and the /umami mount", () => {
    expect(
      resolveUmamiSendUrls(
        "https://stats.example.com/umami/script.js",
        "/api/insight",
      ),
    ).toEqual([
      "https://stats.example.com/umami/api/insight",
      "https://stats.example.com/api/insight",
    ]);
  });

  it("refuses a private host", () => {
    expect(
      resolveUmamiSendUrls("http://10.0.0.5/script.js", "/api/send"),
    ).toEqual([]);
  });
});

describe("UMAMI_PROXY_PREFIX", () => {
  it("sits under the public monitoring family the proxy gate admits", () => {
    expect(UMAMI_PROXY_PREFIX.startsWith("/api/monitoring/")).toBe(true);
  });
});
