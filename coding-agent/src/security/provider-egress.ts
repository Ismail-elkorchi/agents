import { createHash } from 'node:crypto';
import type { ModelProvider, ModelProviderSession, ModelRequest } from '@agent-core/model';
import type { CodingWorkspaceIdentity } from './workspace-identity.js';
import { decideWorkspaceAction, type WorkspaceTrustLevel } from './workspace-trust.js';

export interface ProviderEgressReceipt {
  readonly requestSha256: string;
  readonly provider: string;
  readonly workspaceId: string;
  readonly bytes: number;
  readonly createdAt: string;
}

export interface ProviderEgressPolicy {
  readonly maxRequestBytes?: number;
  readonly onAdmitted?: (receipt: ProviderEgressReceipt) => void;
}

const secretPatterns: readonly RegExp[] = Object.freeze([
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key)\s*[=:]\s*[^\s"']{8,}/giu
]);

export function protectProviderEgress(input: {
  readonly provider: ModelProvider;
  readonly workspace: CodingWorkspaceIdentity;
  readonly trustLevel: WorkspaceTrustLevel;
  readonly policy?: ProviderEgressPolicy;
}): ModelProvider {
  const admit = (request: ModelRequest): void => {
    const decision = decideWorkspaceAction(input.trustLevel, 'provider_egress');
    if (decision.kind !== 'allowed') throw new Error(decision.reason);
    const inspected = inspectRequest(request, input.policy?.maxRequestBytes ?? 8 * 1024 * 1024);
    input.policy?.onAdmitted?.(Object.freeze({
      requestSha256: inspected.sha256,
      provider: input.provider.id,
      workspaceId: input.workspace.id,
      bytes: inspected.bytes,
      createdAt: new Date().toISOString()
    }));
  };
  return wrapProvider(input.provider, admit);
}

export function redactSensitiveText(value: string, maxBytes = 64 * 1024): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Redacted text byte limit must be a positive safe integer.');
  let result = value;
  for (const pattern of secretPatterns) { pattern.lastIndex = 0; result = result.replace(pattern, '[REDACTED]'); }
  result = makeSensitiveControlsVisible(result);
  if (Buffer.byteLength(result) <= maxBytes) return result;
  let end = Math.min(result.length, maxBytes);
  while (end > 0 && Buffer.byteLength(result.slice(0, end)) > maxBytes) end -= 1;
  return `${result.slice(0, end)}\n[TRUNCATED]`;
}

function makeSensitiveControlsVisible(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && ((code <= 0x08) || (code >= 0x0b && code <= 0x1f) || code === 0x7f
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069))) {
      result += `\\u{${code.toString(16).toUpperCase()}}`;
    } else result += character;
  }
  return result;
}

function inspectRequest(request: ModelRequest, maxBytes: number): { readonly bytes: number; readonly sha256: string } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Provider egress byte limit must be a positive safe integer.');
  const hash = createHash('sha256');
  let bytes = 0;
  const inspect = (value: string) => {
    bytes += Buffer.byteLength(value);
    if (bytes > maxBytes) throw new Error(`Provider request exceeds the ${String(maxBytes)} byte egress limit.`);
    for (const pattern of secretPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) throw new Error('Provider request contains content matching the default sensitive-data policy.');
    }
    hash.update(value).update('\0');
  };
  inspect(request.model);
  for (const message of request.messages) {
    inspect(message.role); inspect(message.content);
    if (message.role === 'assistant' && message.reasoning) inspect(message.reasoning);
    if ('images' in message) {
      for (const image of message.images) {
        const imageBytes = image.type === 'bytes' ? image.data.byteLength : Buffer.byteLength(image.data, 'base64');
        bytes += imageBytes;
        if (bytes > maxBytes) throw new Error(`Provider request exceeds the ${String(maxBytes)} byte egress limit.`);
        hash.update(image.type === 'bytes' ? image.data : Buffer.from(image.data, 'base64'));
      }
    }
    if (message.role === 'assistant' && message.toolCalls) inspect(JSON.stringify(message.toolCalls));
  }
  if (request.tools) inspect(JSON.stringify(request.tools));
  if (request.providerOptions) inspect(JSON.stringify(request.providerOptions));
  if (request.metadata) inspect(JSON.stringify(request.metadata));
  return { bytes, sha256: hash.digest('hex') };
}

function wrapProvider(provider: ModelProvider, admit: (request: ModelRequest) => void): ModelProvider {
  const stream = provider.stream?.bind(provider);
  const createSession = provider.createSession?.bind(provider);
  return Object.freeze({
    id: provider.id,
    describe: () => provider.describe(),
    describeModel: (model: string) => provider.describeModel(model),
    complete: async (request: ModelRequest) => { admit(request); return provider.complete(request); },
    ...(stream ? { stream: (request: ModelRequest) => { admit(request); return stream(request); } } : {}),
    ...(createSession ? { createSession: () => wrapSession(createSession(), admit) } : {})
  });
}

function wrapSession(session: ModelProviderSession | undefined, admit: (request: ModelRequest) => void): ModelProviderSession {
  if (!session) throw new Error('Provider did not create the declared session.');
  const stream = session.stream?.bind(session);
  return Object.freeze({
    complete: async (request: ModelRequest) => { admit(request); return session.complete(request); },
    ...(stream ? { stream: (request: ModelRequest) => { admit(request); return stream(request); } } : {}),
    retryDisposition: (error: unknown) => session.retryDisposition(error),
    ...(session.restoreProviderState ? { restoreProviderState: session.restoreProviderState.bind(session) } : {}),
    ...(session.resetContinuation ? { resetContinuation: session.resetContinuation.bind(session) } : {}),
    ...(session.close ? { close: session.close.bind(session) } : {})
  });
}
