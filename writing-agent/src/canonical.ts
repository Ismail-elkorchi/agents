import { createHash, randomUUID } from 'node:crypto';
import { hashJson } from '@agent-core/persistence';

export function contentId(prefix: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(prefix)) throw new TypeError(`Invalid content ID prefix: ${prefix}`);
  return `${prefix}-${hashJson(value)}`;
}

export function randomId(prefix: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(prefix)) throw new TypeError(`Invalid random ID prefix: ${prefix}`);
  return `${prefix}-${randomUUID()}`;
}

export function textSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function nowTimestamp(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}
