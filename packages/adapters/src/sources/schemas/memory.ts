import { z } from 'zod';

const isoDate = z.string().min(1);

export const memorySearchResultSchema = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    content: z.string(),
    summary: z.string().nullable().optional(),
    score: z.number(),
    importance: z.number().optional(),
    confidence: z.number().optional(),
    usefulness: z.number().optional(),
    createdAt: isoDate,
    lastReinforcedAt: isoDate.optional(),
    sourceRefs: z.array(z.object({ kind: z.string(), ref: z.string() }).passthrough()).optional(),
    trust: z.string().optional(),
    tokens: z.number().optional(),
    truncated: z.boolean().optional(),
    /** Optional ownership fields; when present they must match the acting user / workspace. */
    ownerActorId: z.string().optional(),
    workspaceId: z.string().optional(),
    userId: z.string().optional(),
  })
  .passthrough();

export const memorySearchResponseSchema = z
  .object({
    retrievalId: z.string().min(1),
    traceId: z.string().optional(),
    query: z.object({ length: z.number() }).passthrough().optional(),
    profile: z
      .object({
        name: z.string(),
        version: z.number(),
        status: z.string(),
        served: z.string().optional(),
      })
      .passthrough()
      .optional(),
    results: z.array(memorySearchResultSchema),
    stats: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const memoryProfilesResponseSchema = z
  .object({
    profiles: z.array(
      z
        .object({
          name: z.string().min(1),
          version: z.number(),
          status: z.string(),
          scope: z.string().optional(),
          canaryPercent: z.number().optional(),
          description: z.string().optional(),
          createdAt: isoDate.optional(),
        })
        .passthrough()
    ),
  })
  .passthrough();

export type MemorySearchResponse = z.infer<typeof memorySearchResponseSchema>;
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;
