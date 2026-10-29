import type { AuditEventInput, ContextManifest, ContextPacket } from '@smallseedlabs/proba-protocol';
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
  /** Value of the `X-Local-Identity` header (JSON). Only the local identity resolver reads it. */
  localIdentity?: string;
  /** Value of the `X-Act-As` header (an act-as assertion JWT). */
  actAsAssertion?: string;
  /**
   * Value of the `Authorization` header. For `act_as_assertion` this may carry the Hub assertion
   * (`Bearer <jwt>`), matching how the Hub's ContextClient calls the bridge. For
   * `firebase_passthrough` it is the caller's Firebase ID token.
   */
  authorization?: string;
  /**
   * Scope hints for `firebase_passthrough` (taken from the request body). Ignored by assertion
   * and local resolvers.
   */
  scope?: {
    workspaceId?: string;
    userId?: string;
    goalId?: string;
    threadId?: string;
  };
}

/** Turns inbound credentials into a verified identity; rejects when they are missing or invalid. */
export interface IdentityResolver {
  resolve(credentials: IdentityCredentials): Promise<ResolvedIdentity>;
}

/** Decision of a fixed-window rate limiter. */
export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/** Fixed-window limiter (per caller and per user). Memory adapters are refused in production. */
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
  close?(): Promise<void>;
}

/**
 * Stores seen assertion `jti` values until they expire, so a replayed assertion is refused.
 * Memory adapters are refused in production.
 */
export interface JtiStore {
  /**
   * Records `jti` with a TTL of `ttlSeconds`. Returns `true` when this is the first sighting,
   * `false` when the jti was already seen (replay).
   */
  claim(jti: string, ttlSeconds: number): Promise<boolean>;
  close?(): Promise<void>;
}

/** Manifest-only record of a built packet (never item text), for admin review. */
export interface PacketRecord {
  packetId: string;
  packetHash: string;
  workspaceId: string;
  userId: string;
  goalId: string;
  stepId: string;
  configVersion: string;
  templateVersion: string;
  manifest: ContextManifest;
  createdAt: string;
}

/** Stores packet manifests for admin `GET /v1/context/packets*`. Memory adapters are refused in production. */
export interface PacketStore {
  put(record: PacketRecord): Promise<void>;
  get(packetId: string): Promise<PacketRecord | undefined>;
  listByGoal(goalId: string, options?: { limit?: number; cursor?: string }): Promise<{ items: PacketRecord[]; nextCursor?: string }>;
  close?(): Promise<void>;
}

/** Admin role after Firebase verification and allow-list checks. */
export type AdminRole = 'admin' | 'viewer';

export interface AdminSession {
  subject: string;
  email: string;
  role: AdminRole;
}

/** Verifies a Firebase ID token and maps it to an admin/viewer session (or denies). */
export interface AdminAuthorizer {
  authorize(authorizationHeader: string | undefined): Promise<AdminSession>;
}
