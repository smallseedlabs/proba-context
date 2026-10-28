/**
 * Redaction of secrets and personal data in context items, applied before an item enters a packet.
 * Idempotent: redacting redacted text changes nothing. Secrets are always redacted; personal data
 * (email, phone, card with a valid Luhn check, IBAN with a valid check digit, SSN) when `pii` is set.
 * Patterns follow proba-memory's write-path redaction so both services treat the same strings alike, except that
 * prefix-anchored tokens (GitHub, AWS, Slack, Google, JWT) match even when glued to a preceding word character:
 * a secret must not survive because of what happens to sit in front of it.
 */

export interface Redaction {
  type: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
}

export interface RedactorOptions {
  /** Also redact personal data (email, phone, card, IBAN, SSN). Secrets are always redacted. */
  pii: boolean;
}

interface Rule {
  type: string;
  pattern: RegExp;
  pii: boolean;
  /** Replace only when this returns true (for example a Luhn check). */
  accept?: (match: string) => boolean;
  /** Build the replacement; default is the label. */
  replace?: (match: string, label: string, groups: string[]) => string;
}

const label = (type: string): string => `[REDACTED:${type}]`;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of value) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

const RULES: Rule[] = [
  // --- secrets (always) ---
  { type: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, pii: false },
  { type: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, pii: false },
  { type: 'aws_key', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, pii: false },
  { type: 'github_token', pattern: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, pii: false },
  { type: 'slack_token', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}\b/g, pii: false },
  { type: 'api_key', pattern: /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/g, pii: false },
  { type: 'google_key', pattern: /AIza[0-9A-Za-z_-]{35}/g, pii: false },
  { type: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, pii: false },
  {
    type: 'url_credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    pii: false,
    replace: (_m, l, g) => `${g[0]}${l}@`,
  },
  {
    type: 'credential',
    pattern: /\b(api[_-]?key|secret|password|passwd|pwd|token|authorization|private[_-]?key)(\s*[:=]\s*)(["']?)(?!\[REDACTED)[^\s"',;]{6,}\3/gi,
    pii: false,
    replace: (_m, l, g) => `${g[0]}${g[1]}${l}`,
  },
  // --- personal data (REDACT_PII) ---
  { type: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, pii: true },
  { type: 'card', pattern: /\b(?:\d[ -]?){12,18}\d\b/g, pii: true, accept: (m) => luhnValid(m.replace(/[ -]/g, '')) },
  { type: 'iban', pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, pii: true, accept: ibanValid },
  { type: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, pii: true },
  {
    type: 'phone',
    pattern: /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}(?!\w|\.\d)/g,
    pii: true,
    accept: (m) => {
      const digits = m.replace(/\D/g, '');
      // Dates (2026-10-26) and short ids are not phone numbers.
      return digits.length >= 9 && digits.length <= 15 && !/^\d{4}-\d{2}-\d{2}$/.test(m.trim());
    },
  },
];

export class Redactor {
  constructor(private readonly options: RedactorOptions) {}

  redact(input: string): RedactionResult {
    let text = input;
    const counts = new Map<string, number>();
    for (const rule of RULES) {
      if (rule.pii && !this.options.pii) continue;
      text = text.replace(rule.pattern, (...args: unknown[]) => {
        const match = args[0] as string;
        if (rule.accept && !rule.accept(match)) return match;
        counts.set(rule.type, (counts.get(rule.type) ?? 0) + 1);
        const groups = args.slice(1, -2).filter((g): g is string => typeof g === 'string');
        return rule.replace ? rule.replace(match, label(rule.type), groups) : label(rule.type);
      });
    }
    return { text, redactions: [...counts].map(([type, count]) => ({ type, count })) };
  }
}
