import { describe, expect, it } from "vitest";
import { normalizeNotionId, normalizeNotionParent } from "../src/ids";

describe("normalizeNotionId", () => {
  it("keeps hyphenated UUIDs", () => {
    expect(normalizeNotionId("33D13271-AD65-80E2-84DF-F27F65E9BDF3")).toBe(
      "33d13271-ad65-80e2-84df-f27f65e9bdf3",
    );
  });

  it("hyphenates compact page IDs", () => {
    expect(normalizeNotionId("33d13271ad6580e284dff27f65e9bdf3")).toBe(
      "33d13271-ad65-80e2-84df-f27f65e9bdf3",
    );
  });

  it("extracts IDs from Notion page slugs", () => {
    expect(normalizeNotionId("Dump-33d13271ad6580e284dff27f65e9bdf3")).toBe(
      "33d13271-ad65-80e2-84df-f27f65e9bdf3",
    );
  });

  it("extracts IDs from Notion URLs", () => {
    expect(
      normalizeNotionId(
        "https://www.notion.so/acme/Dump-33d13271ad6580e284dff27f65e9bdf3?pvs=4",
      ),
    ).toBe("33d13271-ad65-80e2-84df-f27f65e9bdf3");
  });

  it("rejects values without a Notion UUID", () => {
    expect(() => normalizeNotionId("Dump")).toThrow(
      "Notion ID must be a Notion UUID",
    );
  });
});

describe("normalizeNotionParent", () => {
  it("uses page parents by default", () => {
    expect(normalizeNotionParent("33d13271ad6580e284dff27f65e9bdf3")).toEqual({
      page_id: "33d13271-ad65-80e2-84df-f27f65e9bdf3",
    });
  });

  it("uses database parents for database view URLs", () => {
    expect(
      normalizeNotionParent(
        "https://www.notion.so/1e8a0cc7612780e88e71e45d2669ca85?v=1e8a0cc7612781eab16c000c01c31991&source=copy_link",
      ),
    ).toEqual({
      database_id: "1e8a0cc7-6127-80e8-8e71-e45d2669ca85",
    });
  });

  it("allows explicit database parent IDs", () => {
    expect(
      normalizeNotionParent("database:1e8a0cc7612780e88e71e45d2669ca85"),
    ).toEqual({
      database_id: "1e8a0cc7-6127-80e8-8e71-e45d2669ca85",
    });
  });
});
