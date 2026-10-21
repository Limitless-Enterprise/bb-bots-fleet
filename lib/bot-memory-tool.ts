import { z } from "zod";
import { botMemoryKindSchema } from "./bot-memory-kinds";

const sha = z.string().regex(/^[a-f0-9]{64}$/);

export const botMemoryToolSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), kind: botMemoryKindSchema.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("read"), id: z.string().min(1) }).strict(),
  z.object({ action: z.literal("search"), query: z.string().min(1).max(500), limit: z.number().int().min(1).max(50).optional() }).strict(),
  z.object({
    action: z.literal("write"),
    id: z.string().min(1).optional(),
    title: z.string().min(1).max(200),
    kind: botMemoryKindSchema,
    importance: z.number().int().min(0).max(100),
    body: z.string().min(1).max(4000),
    reviewBy: z.string().max(32).nullable().optional(),
    expectedSha256: sha.optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.id && !value.expectedSha256) ctx.addIssue({ code: "custom", message: "expectedSha256 is required when updating a memory entry (id is set)" });
  }),
  z.object({ action: z.literal("forget"), id: z.string().min(1), expectedSha256: sha }).strict(),
]);
