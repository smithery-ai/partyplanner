import { describe, expect, it } from "vitest";
import { DEFAULT_AUTO_ADVANCE } from "./advance-mode";

describe("advance mode", () => {
  it("defaults to fast-forwarding queued workflow work", () => {
    expect(DEFAULT_AUTO_ADVANCE).toBe(true);
  });
});
