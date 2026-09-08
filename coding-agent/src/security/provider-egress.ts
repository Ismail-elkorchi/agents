import {
  modelInputIdentity,
  type CompiledModelRequest,
  type ModelContextTransformRequest,
  type ModelNativeContinuation,
  type ModelProvider,
  type ModelProviderSession,
  type ModelRequest,
  type ModelSteeringSubmission,
  type ModelTransportOptions
} from '@agent-core/model';
import { createHash } from 'node:crypto';
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
  /"(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key)"\s*:\s*"[^"\s]{8,}"/giu,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key)\s*[=:]\s*[^\s"']{8,}/giu
]);

export function protectProviderEgress(input: {
  readonly provider: ModelProvider;
  readonly workspace: CodingWorkspaceIdentity;
  readonly trustLevel: WorkspaceTrustLevel;
  readonly policy?: ProviderEgressPolicy;
}): ModelProvider {
  const admit = (request: ModelRequest, body?: string): void => {
    const decision = decideWorkspaceAction(input.trustLevel, 'provider_egress');
    if (decision.kind !== 'allowed') throw new Error(decision.reason);
    const inspected =
      body === undefined
        ? inspectRequest(request, input.policy?.maxRequestBytes ?? 8 * 1024 * 1024)
        : inspectEncoded(body, input.policy?.maxRequestBytes ?? 8 * 1024 * 1024);
    input.policy?.onAdmitted?.(
      Object.freeze({
        requestSha256: inspected.sha256,
        provider: input.provider.id,
        workspaceId: input.workspace.id,
        bytes: inspected.bytes,
        createdAt: new Date().toISOString()
      })
    );
  };
  const admitCompiled = async (request: CompiledModelRequest): Promise<void> => {
    if (!Object.isFrozen(request) || !deeplyFrozen(request.body) || !deeplyFrozen(request.retainedBody)) {
      throw new Error('Provider egress requires an immutable compiled request.');
    }
    const material =
      request.retainedBody === undefined
        ? request.body
        : { body: request.body, retainedBody: request.retainedBody };
    if (
      request.provider !== input.provider.id ||
      request.model !== request.logicalRequest.model ||
      request.inputIdentity !== (await modelInputIdentity(material))
    ) {
      throw new Error('Provider compiled input identity does not match its sent body.');
    }
    admit(request.logicalRequest, JSON.stringify(material));
  };
  return wrapProvider(input.provider, admit, admitCompiled);
}

export function redactSensitiveText(value: string, maxBytes = 64 * 1024): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError('Redacted text byte limit must be a positive safe integer.');
  let result = value;
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
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
    if (
      code !== undefined &&
      (code <= 0x08 ||
        (code >= 0x0b && code <= 0x1f) ||
        code === 0x7f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069))
    ) {
      result += `\\u{${code.toString(16).toUpperCase()}}`;
    } else result += character;
  }
  return result;
}

function inspectRequest(
  request: ModelRequest,
  maxBytes: number
): { readonly bytes: number; readonly sha256: string } {
  // Every supplied control, schema, media item and opaque protocol payload is part of egress.
  const material = Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'signal'));
  return inspectEncoded(JSON.stringify(material), maxBytes);
}

function inspectEncoded(
  encoded: string,
  maxBytes: number
): { readonly bytes: number; readonly sha256: string } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError('Provider egress byte limit must be a positive safe integer.');
  const bytes = Buffer.byteLength(encoded);
  if (bytes > maxBytes)
    throw new Error(`Provider request exceeds the ${String(maxBytes)} byte egress limit.`);
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(encoded))
      throw new Error('Provider request contains content matching the default sensitive-data policy.');
  }
  return { bytes, sha256: createHash('sha256').update(encoded).digest('hex') };
}

function deeplyFrozen(value: unknown): boolean {
  return (
    value === null ||
    typeof value !== 'object' ||
    (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen))
  );
}

type CompiledAdmission = (request: CompiledModelRequest) => Promise<void>;

function protectNativeAdmission(
  options: ModelTransportOptions | undefined,
  admitCompiled: CompiledAdmission
): ModelTransportOptions | undefined {
  const native = options?.native;
  if (!native) return options;
  return {
    ...options,
    native: {
      admit: async (dispatch) => {
        await admitCompiled(dispatch.compiled);
        await native.admit(dispatch);
      }
    }
  };
}

function wrapProvider(
  provider: ModelProvider,
  admit: (request: ModelRequest) => void,
  admitCompiled: CompiledAdmission
): ModelProvider {
  const stream = provider.stream?.bind(provider);
  const createSession = provider.createSession?.bind(provider);
  const requestRecovery = provider.requestRecovery?.bind(provider);
  const compileRequest = provider.compileRequest?.bind(provider);
  const completeCompiled = provider.completeCompiled?.bind(provider);
  const streamCompiled = provider.streamCompiled?.bind(provider);
  const transformContext = provider.transformContext?.bind(provider);
  const compileContextTransform = provider.compileContextTransform?.bind(provider);
  const transformContextCompiled = provider.transformContextCompiled?.bind(provider);
  return Object.freeze({
    id: provider.id,
    implementationId: provider.implementationId,
    describe: () => provider.describe(),
    describeModel: (model: string) => provider.describeModel(model),
    complete: async (request: ModelRequest) => {
      if (compileRequest && completeCompiled) {
        const compiled = await compileRequest(request);
        await admitCompiled(compiled);
        return completeCompiled(compiled);
      }
      admit(request);
      return provider.complete(request);
    },
    ...(stream
      ? {
          stream: async function* (request: ModelRequest) {
            if (compileRequest && streamCompiled) {
              const compiled = await compileRequest(request);
              await admitCompiled(compiled);
              yield* streamCompiled(compiled);
            } else {
              admit(request);
              yield* stream(request);
            }
          }
        }
      : {}),
    ...(createSession
      ? { createSession: () => wrapSession(createSession(), admit, admitCompiled, compileRequest) }
      : {}),
    ...(compileRequest ? { compileRequest } : {}),
    ...(completeCompiled
      ? {
          completeCompiled: async (request: CompiledModelRequest, options?: ModelTransportOptions) => {
            await admitCompiled(request);
            return completeCompiled(request, protectNativeAdmission(options, admitCompiled));
          }
        }
      : {}),
    ...(streamCompiled
      ? {
          streamCompiled: async function* (request: CompiledModelRequest, options?: ModelTransportOptions) {
            await admitCompiled(request);
            yield* streamCompiled(request, protectNativeAdmission(options, admitCompiled));
          }
        }
      : {}),
    ...(compileContextTransform ? { compileContextTransform } : {}),
    ...(transformContextCompiled
      ? {
          transformContextCompiled: async (transformId: string, request: CompiledModelRequest) => {
            await admitCompiled(request);
            return transformContextCompiled(transformId, request);
          }
        }
      : {}),
    ...(transformContext
      ? {
          transformContext: async (request: ModelContextTransformRequest) => {
            if (compileContextTransform && transformContextCompiled) {
              const compiled = await compileContextTransform(request);
              await admitCompiled(compiled);
              return transformContextCompiled(request.transformId, compiled);
            }
            admit(request.request);
            return transformContext(request);
          }
        }
      : {}),
    ...(requestRecovery ? { requestRecovery } : {})
  });
}

function wrapSession(
  session: ModelProviderSession | undefined,
  admit: (request: ModelRequest) => void,
  admitCompiled: CompiledAdmission,
  compileRequest: ModelProvider['compileRequest']
): ModelProviderSession {
  if (!session) throw new Error('Provider did not create the declared session.');
  const stream = session.stream?.bind(session);
  const completeCompiled = session.completeCompiled?.bind(session);
  const streamCompiled = session.streamCompiled?.bind(session);
  const steer = session.steer?.bind(session);
  const deliverToolResults = session.deliverToolResults?.bind(session);
  const continueNative = session.continueNative?.bind(session);
  let currentModel: string | undefined;
  let nativeAdmissionActive = false;
  return Object.freeze({
    complete: async (request: ModelRequest) => {
      currentModel = request.model;
      nativeAdmissionActive = false;
      if (compileRequest && completeCompiled) {
        const compiled = await compileRequest(request);
        await admitCompiled(compiled);
        return completeCompiled(compiled);
      }
      admit(request);
      return session.complete(request);
    },
    ...(stream
      ? {
          stream: async function* (request: ModelRequest) {
            currentModel = request.model;
            nativeAdmissionActive = false;
            if (compileRequest && streamCompiled) {
              const compiled = await compileRequest(request);
              await admitCompiled(compiled);
              yield* streamCompiled(compiled);
            } else {
              admit(request);
              yield* stream(request);
            }
          }
        }
      : {}),
    ...(completeCompiled
      ? {
          completeCompiled: async (request: CompiledModelRequest, options?: ModelTransportOptions) => {
            await admitCompiled(request);
            currentModel = request.model;
            nativeAdmissionActive = options?.native !== undefined;
            return completeCompiled(request, protectNativeAdmission(options, admitCompiled));
          }
        }
      : {}),
    ...(streamCompiled
      ? {
          streamCompiled: async function* (request: CompiledModelRequest, options?: ModelTransportOptions) {
            await admitCompiled(request);
            currentModel = request.model;
            nativeAdmissionActive = options?.native !== undefined;
            yield* streamCompiled(request, protectNativeAdmission(options, admitCompiled));
          }
        }
      : {}),
    ...(steer
      ? {
          steer: (submission: ModelSteeringSubmission) => {
            if (currentModel === undefined)
              throw new Error('Cannot admit steering before its model request.');
            if (!nativeAdmissionActive) admit({ model: currentModel, messages: submission.input });
            return steer(submission);
          }
        }
      : {}),
    ...(deliverToolResults
      ? {
          deliverToolResults: (
            delivery: Parameters<NonNullable<ModelProviderSession['deliverToolResults']>>[0]
          ) => {
            if (currentModel === undefined)
              throw new Error('Cannot admit tool results before their model request.');
            if (!nativeAdmissionActive) admit({ model: currentModel, messages: delivery.results });
            return deliverToolResults(delivery);
          }
        }
      : {}),
    ...(continueNative
      ? {
          continueNative: (continuation: ModelNativeContinuation) => {
            if (currentModel === undefined)
              throw new Error('Cannot admit continuation before its model request.');
            if (!nativeAdmissionActive) {
              admit({
                model: currentModel,
                messages: continuation.input,
                ...(continuation.tools === undefined ? {} : { tools: continuation.tools })
              });
            }
            return continueNative(continuation);
          }
        }
      : {}),
    ...(session.steeringStatus ? { steeringStatus: session.steeringStatus.bind(session) } : {}),
    ...(session.toolResultStatus ? { toolResultStatus: session.toolResultStatus.bind(session) } : {}),
    ...(session.nativeDeliveryStatus
      ? { nativeDeliveryStatus: session.nativeDeliveryStatus.bind(session) }
      : {}),
    ...(session.restoreProviderState
      ? { restoreProviderState: session.restoreProviderState.bind(session) }
      : {}),
    ...(session.resetContinuation ? { resetContinuation: session.resetContinuation.bind(session) } : {}),
    ...(session.close ? { close: session.close.bind(session) } : {})
  });
}
