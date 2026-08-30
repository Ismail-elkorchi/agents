import { createHash, randomUUID } from 'node:crypto';
import { hashJson } from '@agent-core/evidence';
import { normalizeJsonSafe, type JsonValue } from '@agent-core/json';
import type * as z from 'zod';

export function canonicalJson(value: unknown): JsonValue {
  return normalizeJsonSafe(value, {
    maxDepth: 128,
    maxCollectionEntries: 200_000,
    maxStringBytes: 16_000_000,
    maxTotalBytes: 64_000_000
  }).value;
}

export function canonicalSha256(value: unknown): string {
  return hashJson(canonicalJson(value));
}

export function contentId(prefix: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(prefix)) throw new TypeError(`Invalid content ID prefix: ${prefix}`);
  return `${prefix}-${canonicalSha256(value)}`;
}

export function randomId(prefix: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(prefix)) throw new TypeError(`Invalid random ID prefix: ${prefix}`);
  return `${prefix}-${randomUUID()}`;
}

export function textSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function adoptSchema<Schema extends z.ZodType>(schema: Schema, value: unknown): Readonly<z.output<Schema>> {
  return deepFreeze(schema.parse(value));
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return Object.freeze(value);
}

export function nowTimestamp(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}
