import { describe, expect, it } from "vitest";

import { iosMetadataFor, pickIosMetadata } from "../ios-metadata";

describe("iOS metadata: eventId", () => {
  const metadata = { eventId: "ev1", url: "/seizures?event=ev1" };

  it("passes the seizure cluster's eventId and url through", () => {
    expect(pickIosMetadata(metadata)).toEqual(metadata);
    expect(iosMetadataFor({ metadata }, false)).toEqual(metadata);
  });

  it("drops it for a managed delivery", () => {
    expect(iosMetadataFor({ metadata }, true)).toEqual({});
  });
});
