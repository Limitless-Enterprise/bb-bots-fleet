import { describe, expect, it } from "vitest";
import { botsThreadIdFromSubPath, botsThreadSubPath } from "./bots-panel";

describe("bots panel routing", () => {
  it("parses thread subpaths", () => {
    expect(botsThreadIdFromSubPath("")).toBeNull();
    expect(botsThreadIdFromSubPath("thread/abc")).toBe("abc");
    expect(botsThreadIdFromSubPath("inbox")).toBeNull();
  });

  it("builds thread subpaths", () => {
    expect(botsThreadSubPath("abc")).toBe("thread/abc");
  });
});
