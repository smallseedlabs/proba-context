import { z } from 'zod';
import { sectionKindSchema, stepTypeSchema } from '@smallseedlabs/proba-protocol';

/** Section kinds double as source names: one source feeds one section. */
export const SOURCE_NAMES = sectionKindSchema.options;

const hostSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/, 'must be a lower-case host name, optionally with :port (no scheme, no path)');

export const sourceConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Time the source has to answer before the packet is built without it (a `source_timeout` gap). */
    timeoutMs: z.number().int().positive().max(30_000),
    /** Share of the token budget this source may use, between 0 and 1. */
    tokenShare: z.number().min(0).max(1),
  })
  .strict();

export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export const cacheConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    ttlSeconds: z.number().int().nonnegative().max(86_400).default(0),
    maxEntries: z.number().int().positive().max(1_000_000).default(1000),
  })
  .strict()
  .refine((c) => !c.enabled || c.ttlSeconds > 0, {
    message: 'ttlSeconds must be greater than 0 when the cache is enabled',
    path: ['ttlSeconds'],
  });

export type CacheConfig = z.infer<typeof cacheConfigSchema>;

const priorityShape = Object.fromEntries(SOURCE_NAMES.map((name) => [name, z.number().int().nonnegative()])) as Record<
  (typeof SOURCE_NAMES)[number],
  z.ZodNumber
>;

export const budgetConfigSchema = z
  .object({
    defaultTokens: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    /** Section priority when the budget is tight: lower numbers are kept first. */
    priorities: z.object(priorityShape).strict(),
  })
  .strict()
  .refine((b) => b.defaultTokens <= b.maxTokens, {
    message: 'defaultTokens must not exceed maxTokens',
    path: ['defaultTokens'],
  });

export type BudgetConfig = z.infer<typeof budgetConfigSchema>;

export const limitsConfigSchema = z
  .object({
    maxNeedsPerRequest: z.number().int().positive().max(20).default(20),
    maxItemsPerSource: z.number().int().positive().max(500).default(50),
    maxItemChars: z.number().int().positive().default(4000),
    maxRequestBytes: z.number().int().positive().default(65_536),
  })
  .strict();

export type LimitsConfig = z.infer<typeof limitsConfigSchema>;

const sourcesShape = Object.fromEntries(SOURCE_NAMES.map((name) => [name, sourceConfigSchema])) as Record<
  (typeof SOURCE_NAMES)[number],
  typeof sourceConfigSchema
>;

export const identityConfigSchema = z
  .object({
    /** `act_as_assertion`: verify the Hub-minted `X-Act-As` JWT. `firebase_passthrough`: verify the caller's Firebase ID token. */
    mode: z.enum(['act_as_assertion', 'firebase_passthrough']),
  })
  .strict();

export const contextConfigSchema = z
  .object({
    version: z.string().min(1),
    identity: identityConfigSchema,
    sources: z.object(sourcesShape).strict(),
    cache: cacheConfigSchema.default({}),
    budget: budgetConfigSchema,
    /** Hosts the service may call (proba-audit, proba-memory, ...). Everything else is refused. */
    allowedDownstreamHosts: z.array(hostSchema).max(32),
    limits: limitsConfigSchema.default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const total = SOURCE_NAMES.reduce((sum, name) => {
      const source = config.sources[name];
      return source.enabled ? sum + source.tokenShare : sum;
    }, 0);
    // Tolerate floating point noise (0.1 + 0.2 ...).
    if (total > 1 + 1e-9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `tokenShare of the enabled sources adds up to ${total.toFixed(3)}; it must not exceed 1`,
        path: ['sources'],
      });
    }
  });

export type ContextConfig = z.infer<typeof contextConfigSchema>;
export type ContextConfigInput = z.input<typeof contextConfigSchema>;

/** One section of a template: which section kind, whether the packet needs it, and how many items it may carry. */
export const templateSectionSchema = z
  .object({
    kind: sectionKindSchema,
    required: z.boolean().default(false),
    maxItems: z.number().int().positive().max(500).optional(),
  })
  .strict();

/** A versioned template: which sections the packet for a step type is built from. */
export const templateSchema = z
  .object({
    templateVersion: z.string().min(1),
    stepType: stepTypeSchema,
    description: z.string().min(1),
    sections: z
      .array(templateSectionSchema)
      .min(1)
      .refine((sections) => new Set(sections.map((s) => s.kind)).size === sections.length, {
        message: 'a section kind may appear only once',
      }),
  })
  .strict();

export type Template = z.infer<typeof templateSchema>;
export type TemplateSection = z.infer<typeof templateSectionSchema>;

/** Policy statements the policy source serves. */
export const policyFileSchema = z
  .object({
    version: z.string().min(1),
    statements: z
      .array(
        z
          .object({
            id: z.string().min(1),
            text: z.string().min(1),
            appliesTo: z.array(stepTypeSchema).min(1),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

export type PolicyFile = z.infer<typeof policyFileSchema>;

/** Tools the tool catalog source serves. */
export const toolsFileSchema = z
  .object({
    version: z.string().min(1),
    tools: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be lower-case snake_case'),
            description: z.string().min(1),
            risk: z.enum(['low', 'medium', 'high']),
            appliesTo: z.array(stepTypeSchema).min(1),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

export type ToolsFile = z.infer<typeof toolsFileSchema>;
