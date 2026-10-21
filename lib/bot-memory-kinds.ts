import { z } from "zod";

export const botMemoryKindSchema = z.enum(["fact", "preference", "decision", "procedure", "episode", "reference"]);
export type BotMemoryKind = z.infer<typeof botMemoryKindSchema>;
