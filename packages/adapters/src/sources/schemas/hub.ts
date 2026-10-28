import { z } from 'zod';

const isoDate = z.string().min(1);

const budgetAmountSchema = z
  .object({
    daily: z.number().optional(),
    total: z.number().optional(),
    currency: z.string().optional(),
  })
  .passthrough()
  .nullable();

const approvalSchema = z
  .object({
    askId: z.string().min(1),
    askType: z.string().min(1),
    status: z.string().min(1),
    answeredAt: isoDate.nullable(),
    decision: z.string().nullable().optional(),
  })
  .passthrough();

const declineSchema = z
  .object({
    askId: z.string().min(1),
    askType: z.string().min(1),
    status: z.string().min(1),
    answeredAt: isoDate.nullable(),
  })
  .passthrough();

/** Hub `GET /v1/internal/goals/{goalId}/state` body. */
export const goalStateResponseSchema = z
  .object({
    goalId: z.string().min(1),
    workspaceId: z.string().min(1),
    userId: z.string().min(1),
    threadId: z.string().min(1),
    title: z.string(),
    status: z.string().min(1),
    step: z.string().nullable(),
    budget: z
      .object({
        current: budgetAmountSchema.or(z.record(z.unknown()).nullable()),
        proposed: budgetAmountSchema.or(z.record(z.unknown()).nullable()),
      })
      .passthrough(),
    approvals: z.array(approvalSchema),
    declines: z.array(declineSchema),
    campaignIds: z.array(z.string()),
  })
  .passthrough();

export const threadMessageSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    role: z.string().min(1),
    text: z.string(),
    source: z.string().min(1),
    createdAt: isoDate,
    /** Optional ownership fields; when present they must match the acting user / workspace. */
    userId: z.string().optional(),
    workspaceId: z.string().optional(),
  })
  .passthrough();

/** Hub `GET /v1/internal/threads/{threadId}/messages` body. */
export const threadMessagesResponseSchema = z
  .object({
    messages: z.array(threadMessageSchema),
    nextCursor: z.string().nullable(),
  })
  .passthrough();

export type GoalStateResponse = z.infer<typeof goalStateResponseSchema>;
export type ThreadMessage = z.infer<typeof threadMessageSchema>;
export type ThreadMessagesResponse = z.infer<typeof threadMessagesResponseSchema>;
