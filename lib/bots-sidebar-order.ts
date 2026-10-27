import type { BotMetadata, BotSection } from "../contract";

export type BotSidebarPlacement = { bot: BotMetadata; sectionLabel: string };

/** Bots in sidebar order: Main section, then each section, bots within each group. */
export function botsInSidebarOrder(bots: readonly BotMetadata[], sections: readonly BotSection[]): BotSidebarPlacement[] {
  const sectionGroups = [
    { id: null as string | null, name: "Main" },
    ...sections.map((section) => ({ id: section.id, name: section.name })),
  ];
  const placements: BotSidebarPlacement[] = [];
  for (const section of sectionGroups) {
    for (const bot of bots) {
      const botSectionId = sections.some((entry) => entry.id === bot.sectionId) ? bot.sectionId : null;
      if (botSectionId !== section.id) continue;
      placements.push({ bot, sectionLabel: section.name });
    }
  }
  return placements;
}
