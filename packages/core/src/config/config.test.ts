/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers mutate loosely typed config objects */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stepTypeSchema } from '@smallseedlabs/proba-protocol';
import {
  ConfigError,
  loadContextConfig,
  loadPolicyFile,
  loadTemplate,
  loadToolsFile,
  parseContextConfig,
  parseTemplate,
  parseContextConfigYaml,
} from './loader.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const configDir = join(repoRoot, 'config');

function validConfig(): Record<string, unknown> {
  const source = (timeoutMs: number, tokenShare: number) => ({ enabled: true, timeoutMs, tokenShare });
  return {
    version: '1',
    identity: { mode: 'act_as_assertion' },
    sources: {
      policy: source(500, 0.1),
      task: source(1000, 0.15),
      conversation: source(1000, 0.3),
      memory: source(1500, 0.15),
      audit_history: source(1500, 0.1),
      analytics: source(2000, 0.1),
      tools: source(500, 0.1),
    },
    cache: { enabled: false, ttlSeconds: 0, maxEntries: 1000 },
    budget: {
      defaultTokens: 6000,
      maxTokens: 12000,
      priorities: { policy: 0, task: 1, conversation: 2, memory: 3, audit_history: 4, analytics: 5, tools: 6 },
    },
    allowedDownstreamHosts: ['proba-audit:3100'],
    limits: { maxNeedsPerRequest: 20 },
  };
}

function mutate(change: (config: Record<string, any>) => void): unknown {
  const config = validConfig();
  change(config);
  return config;
}

describe('context config schema', () => {
  it('accepts a complete config', () => {
    const config = parseContextConfig(validConfig());
    expect(config.identity.mode).toBe('act_as_assertion');
    expect(config.cache.enabled).toBe(false);
  });

  it('defaults the cache to off with no ttl', () => {
    const config = parseContextConfig(mutate((c) => delete c.cache));
    expect(config.cache).toEqual({ enabled: false, ttlSeconds: 0, maxEntries: 1000 });
  });

  it('fills in limits that are not given', () => {
    const config = parseContextConfig(validConfig());
    expect(config.limits.maxItemsPerSource).toBe(50);
  });

  it.each([
    ['an unknown identity mode', (c: Record<string, any>) => (c.identity.mode = 'shared_secret'), /identity\.mode/],
    ['a missing source', (c: Record<string, any>) => delete c.sources.memory, /sources\.memory/],
    ['an unknown source', (c: Record<string, any>) => (c.sources.email = { timeoutMs: 100, tokenShare: 0.1 }), /Unrecognized key/],
    ['a zero timeout', (c: Record<string, any>) => (c.sources.memory.timeoutMs = 0), /sources\.memory\.timeoutMs/],
    ['a token share above 1', (c: Record<string, any>) => (c.sources.memory.tokenShare = 1.5), /sources\.memory\.tokenShare/],
    ['token shares adding up to more than 1', (c: Record<string, any>) => (c.sources.memory.tokenShare = 0.9), /must not exceed 1/],
    ['an enabled cache without a ttl', (c: Record<string, any>) => (c.cache = { enabled: true, ttlSeconds: 0 }), /ttlSeconds/],
    ['a default budget above the maximum', (c: Record<string, any>) => (c.budget.defaultTokens = 20000), /defaultTokens/],
    ['a missing priority', (c: Record<string, any>) => delete c.budget.priorities.tools, /priorities\.tools/],
    ['a downstream host with a scheme', (c: Record<string, any>) => (c.allowedDownstreamHosts = ['https://proba-audit']), /allowedDownstreamHosts\.0/],
    ['more needs per request than the protocol allows', (c: Record<string, any>) => (c.limits.maxNeedsPerRequest = 50), /maxNeedsPerRequest/],
    ['an unknown top-level key', (c: Record<string, any>) => (c.extra = true), /Unrecognized key/],
    ['a missing version', (c: Record<string, any>) => delete c.version, /version/],
  ])('rejects %s', (_name, change, message) => {
    expect(() => parseContextConfig(mutate(change))).toThrow(ConfigError);
    expect(() => parseContextConfig(mutate(change))).toThrow(message);
  });

  it('ignores the share of a disabled source when adding up', () => {
    const config = parseContextConfig(
      mutate((c) => {
        c.sources.memory.tokenShare = 0.9;
        c.sources.memory.enabled = false;
      })
    );
    expect(config.sources.memory.enabled).toBe(false);
  });
});

describe('config loader', () => {
  it('names the source and every problem in the error', () => {
    try {
      parseContextConfig({ version: '', identity: { mode: 'x' } }, 'bad.yaml');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.message).toContain('bad.yaml');
      expect(e.issues.length).toBeGreaterThan(2);
      expect(e.issues).toEqual(expect.arrayContaining([expect.stringContaining('identity.mode')]));
    }
  });

  it('reports YAML syntax errors', () => {
    expect(() => parseContextConfigYaml('version: [1', 'broken.yaml')).toThrow(/broken\.yaml[\s\S]*YAML syntax error/);
  });

  it('reports a file that cannot be read', () => {
    expect(() => loadContextConfig(join(configDir, 'missing.yaml'))).toThrow(/cannot read file/);
  });

  it('rejects an empty document', () => {
    expect(() => parseContextConfigYaml('', 'empty.yaml')).toThrow(ConfigError);
  });

  it('loads the sample config, which has the cache off', () => {
    const config = loadContextConfig(join(configDir, 'context.config.yaml'));
    expect(config.cache.enabled).toBe(false);
    expect(config.cache.ttlSeconds).toBe(0);
  });

  it('loads the sample policy and tools files', () => {
    expect(loadPolicyFile(join(configDir, 'policy.yaml')).statements.length).toBeGreaterThan(0);
    expect(loadToolsFile(join(configDir, 'tools.yaml')).tools.length).toBeGreaterThan(0);
  });
});

describe('templates', () => {
  const templatesDir = join(configDir, 'templates');

  it('has one versioned template for every step type', () => {
    const files = readdirSync(templatesDir).filter((f) => f.endsWith('.yaml')).sort();
    const expected = stepTypeSchema.options.map((s) => `${s}.v1.yaml`).sort();
    expect(files).toEqual(expected);
  });

  it.each(stepTypeSchema.options)('%s validates against the template schema and matches its file name', (stepType) => {
    const template = loadTemplate(join(templatesDir, `${stepType}.v1.yaml`));
    expect(template.stepType).toBe(stepType);
    expect(template.templateVersion).toBe('1');
    expect(template.sections.some((s) => s.required)).toBe(true);
  });

  it('rejects a template that lists a section twice', () => {
    const template = {
      templateVersion: '1',
      stepType: 'clarify',
      description: 'duplicate section',
      sections: [{ kind: 'policy' }, { kind: 'policy' }],
    };
    expect(() => parseTemplate(template, 'dup.yaml')).toThrow(/only once/);
  });

  it('rejects a template with an unknown step type', () => {
    const template = { templateVersion: '1', stepType: 'chat', description: 'x', sections: [{ kind: 'policy' }] };
    expect(() => parseTemplate(template, 'unknown.yaml')).toThrow(/stepType/);
  });

  it('rejects a file that is not a template', () => {
    expect(() => loadTemplate(join(configDir, 'policy.yaml'))).toThrow(ConfigError);
  });
});
