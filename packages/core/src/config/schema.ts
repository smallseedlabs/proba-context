import { z } from 'zod';
import { sectionKindSchema, stepTypeSchema } from '@smallseedlabs/proba-protocol';

/** Kinds of typed needs the protocol defines. */
export const NEED_KINDS = ['memory_search', 'analytics_compare', 'audit_trace', 'conversation_before'] as const;
export type NeedKind = (typeof NEED_KINDS)[number];

/** Section kinds double as source names: one source feeds one section. */
export const SOURCE_NAMES = sectionKindSchema.options;

const hostSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/, 'must be a lower-case host name, optionally with :port (no scheme, no path)');

/** Per-source fetch cache. Off by default; `ttlSeconds: 0` means no caching. */
export const sourceCacheConfigSchema = z
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

export type SourceCacheConfig = z.infer<typeof sourceCacheConfigSchema>;

/** @deprecated Prefer {@link sourceCacheConfigSchema}; kept as an alias for older call sites. */
export const cacheConfigSchema = sourceCacheConfigSchema;
export type CacheConfig = SourceCacheConfig;

export const sourceConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Time the source has to answer before the packet is built without it (a `source_timeout` gap). */
    timeoutMs: z.number().int().positive().max(30_000),
    /** Share of the token budget this source may use, between 0 and 1. */
    tokenShare: z.number().min(0).max(1),
    /** Per-source fetch cache. Off by default. */
    cache: sourceCacheConfigSchema.default({}),
  })
  .strict();

export type SourceConfig = z.infer<typeof sourceConfigSchema>;

/**
 * Shared cache store settings (which adapter backs `ContextCache`).
 * Per-source enable/TTL live under `sources.<kind>.cache`.
 */
export const cacheStoreConfigSchema = z
  .object({
    /**
     * `memory`: in-process LRU (per-replica; document the caveat before enabling in production).
     * `redis`: shared Redis; requires a password in production and TLS settings via `REDIS_URL` / env.
     */
    backend: z.enum(['memory', 'redis']).default('memory'),
    /**
     * Allow the in-process cache when `NODE_ENV=production`. Default false: production prefers Redis.
     * Each replica keeps its own copy when this is true.
     */
    allowMemoryInProduction: z.boolean().default(false),
  })
  .strict();

export type CacheStoreConfig = z.infer<typeof cacheStoreConfigSchema>;

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

/** Hard limits and source mapping for one registered need kind. */
export const needKindConfigSchema = z
  .object({
    /** Section/source this need reads. */
    source: sectionKindSchema,
    /** Most items a single need of this kind may ask for (also capped by the protocol schema). */
    maxItems: z.number().int().positive().max(500),
    /** Soft token ceiling for items returned by one need of this kind. */
    maxTokens: z.number().int().positive(),
    /**
     * Windows an `analytics_compare` need may ask for. Omitted for other kinds.
     * A window outside this list is refused with `need_out_of_limits`.
     */
    allowedWindows: z.array(z.enum(['1d', '7d', '14d', '30d', '90d'])).min(1).optional(),
  })
  .strict();

export type NeedKindConfig = z.infer<typeof needKindConfigSchema>;

/** Shipped defaults for the hybrid needs loop (2 rounds, 30% extra budget). */
const DEFAULT_NEEDS_CONFIG_INPUT = {
  maxRoundsPerStep: 2,
  extraTokenShare: 0.3,
  kinds: {
    memory_search: { source: 'memory' as const, maxItems: 20, maxTokens: 1500 },
    analytics_compare: {
      source: 'analytics' as const,
      maxItems: 10,
      maxTokens: 1000,
      allowedWindows: ['1d', '7d', '14d', '30d'] as Array<'1d' | '7d' | '14d' | '30d' | '90d'>,
    },
    audit_trace: { source: 'audit_history' as const, maxItems: 100, maxTokens: 2000 },
    conversation_before: { source: 'conversation' as const, maxItems: 50, maxTokens: 2000 },
  },
};

/**
 * Hybrid needs loop (Phase 4). Defaults: two extra rounds per step and 30% extra token budget.
 * Each kind maps to a source port through a registered `NeedHandler`.
 */
export const needsConfigSchema = z
  .object({
    /** Extra needs rounds the brain may run after the first (template-only) packet for a step. */
    maxRoundsPerStep: z.number().int().positive().max(10).default(2),
    /** Extra share of the base budget granted on a needs round (0.3 = 30 percent). */
    extraTokenShare: z.number().min(0).max(1).default(0.3),
    kinds: z
      .object({
        memory_search: needKindConfigSchema,
        analytics_compare: needKindConfigSchema,
        audit_trace: needKindConfigSchema,
        conversation_before: needKindConfigSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((needs, ctx) => {
    const expected: Record<NeedKind, (typeof SOURCE_NAMES)[number]> = {
      memory_search: 'memory',
      analytics_compare: 'analytics',
      audit_trace: 'audit_history',
      conversation_before: 'conversation',
    };
    for (const kind of NEED_KINDS) {
      const cfg = needs.kinds[kind];
      if (cfg.source !== expected[kind]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${kind}.source must be "${expected[kind]}"`,
          path: ['kinds', kind, 'source'],
        });
      }
      if (kind === 'analytics_compare' && (!cfg.allowedWindows || cfg.allowedWindows.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'analytics_compare.allowedWindows is required',
          path: ['kinds', kind, 'allowedWindows'],
        });
      }
      if (kind !== 'analytics_compare' && cfg.allowedWindows !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${kind} must not set allowedWindows`,
          path: ['kinds', kind, 'allowedWindows'],
        });
      }
    }
  });

export type NeedsConfig = z.infer<typeof needsConfigSchema>;

/** Parsed shipped defaults (same object used when `needs` is omitted from the config file). */
export const DEFAULT_NEEDS_CONFIG: NeedsConfig = needsConfigSchema.parse(DEFAULT_NEEDS_CONFIG_INPUT);

const sourcesShape = Object.fromEntries(SOURCE_NAMES.map((name) => [name, sourceConfigSchema])) as Record<
  (typeof SOURCE_NAMES)[number],
  typeof sourceConfigSchema
>;

export const identityConfigSchema = z
  .object({
    /** `act_as_assertion`: verify the Hub-minted assertion. `firebase_passthrough`: verify the caller's Firebase ID token (interactive only). */
    mode: z.enum(['act_as_assertion', 'firebase_passthrough']),
    /**
     * Accept local identities (`Bearer local:…` / `X-Local-Identity`). Honoured only when
     * `NODE_ENV!=production`; production always refuses local identity regardless of this flag.
     */
    allowLocal: z.boolean().default(false),
    /** Cache Hub `POST /v1/internal/authorize` answers. Off by default. */
    authorizeCache: z
      .object({
        enabled: z.boolean().default(false),
        ttlSeconds: z.number().int().nonnegative().max(300).default(0),
      })
      .strict()
      .default({})
      .refine((c) => !c.enabled || c.ttlSeconds > 0, {
        message: 'ttlSeconds must be greater than 0 when authorizeCache is enabled',
        path: ['ttlSeconds'],
      }),
  })
  .strict();

export const redactionConfigSchema = z
  .object({
    /** Also redact personal data (email, phone, card, IBAN, SSN). Secrets are always redacted. */
    pii: z.boolean().default(true),
  })
  .strict();

export type RedactionConfig = z.infer<typeof redactionConfigSchema>;

export const contextConfigSchema = z
  .object({
    version: z.string().min(1),
    identity: identityConfigSchema,
    sources: z.object(sourcesShape).strict(),
    /** Which adapter backs the shared `ContextCache` (per-source enable lives under each source). */
    cacheStore: cacheStoreConfigSchema.default({}),
    budget: budgetConfigSchema,
    /** Hosts the service may call (proba-audit, proba-memory, ...). Everything else is refused. */
    allowedDownstreamHosts: z.array(hostSchema).max(32),
    limits: limitsConfigSchema.default({}),
    /** Hybrid needs loop. Defaults: 2 rounds, 30% extra budget, four registered kinds. */
    needs: needsConfigSchema.default(DEFAULT_NEEDS_CONFIG),
    redaction: redactionConfigSchema.default({}),
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
    /** Tools that must never be described to the brain in the listed steps, whatever tools.yaml says. */
    restrictedTools: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be lower-case snake_case'),
            appliesTo: z.array(stepTypeSchema).min(1),
            reason: z.string().min(1),
          })
          .strict()
      )
      .default([]),
    /** Need kinds the brain may not ask for in the listed steps. */
    restrictedNeeds: z
      .array(
        z
          .object({
            kind: z.enum(NEED_KINDS),
            appliesTo: z.array(stepTypeSchema).min(1),
            reason: z.string().min(1),
          })
          .strict()
      )
      .default([]),
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
