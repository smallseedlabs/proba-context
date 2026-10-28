import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { ZodType, ZodTypeDef } from 'zod';
import {
  contextConfigSchema,
  policyFileSchema,
  templateSchema,
  toolsFileSchema,
  type ContextConfig,
  type PolicyFile,
  type Template,
  type ToolsFile,
} from './schema.js';

/** A config file that cannot be read, parsed or validated. The message names the file and every problem. */
export class ConfigError extends Error {
  readonly source: string;
  readonly issues: readonly string[];

  constructor(source: string, issues: readonly string[]) {
    super(`Invalid configuration in ${source}:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.source = source;
    this.issues = issues;
  }
}

function parseWith<T>(schema: ZodType<T, ZodTypeDef, unknown>, raw: unknown, source: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      source,
      result.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    );
  }
  return result.data;
}

function parseYaml(text: string, source: string): unknown {
  try {
    return yaml.load(text, { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    throw new ConfigError(source, [`YAML syntax error: ${err instanceof Error ? err.message : String(err)}`]);
  }
}

function readYamlFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(path, [`cannot read file: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return parseYaml(text, path);
}

/** Validates an already parsed value (for example an API payload). */
export function parseContextConfig(raw: unknown, source = '(inline config)'): ContextConfig {
  return parseWith(contextConfigSchema, raw, source);
}

/** Parses and validates YAML text. */
export function parseContextConfigYaml(text: string, source = '(inline config)'): ContextConfig {
  return parseContextConfig(parseYaml(text, source), source);
}

/** Reads, parses and validates the context config file. Throws {@link ConfigError}. */
export function loadContextConfig(path: string): ContextConfig {
  return parseContextConfig(readYamlFile(path), path);
}

export function parseTemplate(raw: unknown, source = '(inline template)'): Template {
  return parseWith(templateSchema, raw, source);
}

export function loadTemplate(path: string): Template {
  return parseTemplate(readYamlFile(path), path);
}

export function loadPolicyFile(path: string): PolicyFile {
  return parseWith(policyFileSchema, readYamlFile(path), path);
}

export function loadToolsFile(path: string): ToolsFile {
  return parseWith(toolsFileSchema, readYamlFile(path), path);
}
