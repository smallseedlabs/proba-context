import type { AuditEventInput, ContextPacket } from '@smallseedlabs/proba-protocol';
import type { ResolvedIdentity } from './common.js';

/** Packet cache. Disabled unless `cache.enabled` is set in the config. */
export interface ContextCache {
  get(key: string): Promise<ContextPacket | undefined>;
  set(key: string, packet: ContextPacket, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Token counting for budgeting. */
export interface Tokenizer {
  /** Number of tokens `text` takes in the model's encoding. */
  count(text: string): number;
}

/** Sends audit events to proba-audit. */
export interface AuditEmitter {
  emit(event: AuditEventInput): Promise<void>;
}

/** Time source, injected so that observed-at stamps and expiry checks are deterministic. */
export interface Clock {
  now(): Date;
}

/** Credentials as received on the inbound request. */
export interface IdentityCredentials {
  /** Value of the `X-Act-As` header (an act-as assertion JWT). */
  actAsAssertion?: string;
  /** Value of the `Authorization` header (a Firebase ID token). */
  authorization?: string;
}

/** Turns inbound credentials into a verified identity; rejects when they are missing or invalid. */
export interface IdentityResolver {
  resolve(credentials: IdentityCredentials): Promise<ResolvedIdentity>;
}
