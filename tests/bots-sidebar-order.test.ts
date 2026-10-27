import { describe, expect, it } from "vitest";
import { botsInSidebarOrder } from "../lib/bots-sidebar-order";
import { bot } from "./fixtures";

describe("botsInSidebarOrder", () => {
  it("orders bots by section with Main first and labels sections", () => {
    const alpha = { ...bot, id: "a", name: "Alpha", sectionId: null };
    const beta = { ...bot, id: "b", name: "Beta", sectionId: "sec-1" };
    const placements = botsInSidebarOrder([beta, alpha], [{ id: "sec-1", name: "Fleet", order: 0 }]);
    expect(placements.map((entry) => entry.bot.id)).toEqual(["a", "b"]);
    expect(placements.map((entry) => entry.sectionLabel)).toEqual(["Main", "Fleet"]);
  });
});
