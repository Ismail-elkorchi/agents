import path from 'node:path';
import { type ModelReasoningRequest, parseModelReasoningRequest } from '@agent-core/model';
import { parseJsonObject } from '@agent-core/json';
import { workspaceFileIdentitiesEqual, type WorkspaceFileRoot } from '@agent-core/tools-local';
import type { ProjectConfigurationProposal } from './config/project-proposal.js';
import type { WorkspaceSecurityBoundary } from './security/workspace-security-boundary.js';

export interface CodingAgentInstructionConfiguration { readonly path: string }
export interface CodingAgentCheckConfiguration { readonly id: string; readonly command: string; readonly timeoutMs?: number; readonly maxOutputBytes?: number }
export type CodingAgentProviderId = 'ollama' | 'openrouter' | 'openai' | 'openai-codex';
export interface CodingAgentLimitConfiguration {
  readonly maxConcurrentToolCalls?: number;
  readonly modelTurns?: number;
  readonly totalToolCalls?: number;
  readonly repeatedIdenticalToolCalls?: number;
  readonly elapsedMs?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly activeImageCount?: number;
  readonly activeImageBytes?: number;
  readonly activeImageTokens?: number;
  readonly knownCost?: { readonly amount: number; readonly currency: string };
  readonly consecutiveProviderFailures?: number;
  readonly consecutiveToolFailures?: number;
  readonly providerRetries?: number;
}
export interface CodingAgentConfiguration {
  readonly version: 1;
  readonly provider: CodingAgentProviderId;
  readonly model: string;
  readonly reasoning?: ModelReasoningRequest;
  readonly instructions: readonly CodingAgentInstructionConfiguration[];
  readonly tools: { readonly enabled: readonly string[] };
  readonly authorization: { readonly allowedRisks: readonly ('read' | 'write' | 'execute' | 'network' | 'destructive')[]; readonly requireApprovalFor: readonly ('read' | 'write' | 'execute' | 'network' | 'destructive')[] };
  readonly verification: { readonly required: readonly CodingAgentCheckConfiguration[]; readonly advisory: readonly CodingAgentCheckConfiguration[] };
  readonly limits?: CodingAgentLimitConfiguration;
}

export async function loadCodingAgentConfiguration(root: WorkspaceFileRoot, security: WorkspaceSecurityBoundary, configPath = 'coding-agent.config.json'): Promise<ProjectConfigurationProposal<CodingAgentConfiguration>> {
  const canonicalPath = root.canonicalPath(configPath);
  const file = await root.openFile(canonicalPath);
  try {
    const bytes = await file.readAll(4 * 1024 * 1024);
    const currentIdentity = await file.identityNow();
    if (!workspaceFileIdentitiesEqual(file.identity, currentIdentity)) throw new Error(`Project configuration changed while it was read: ${canonicalPath}`);
    const text = bytes.toString('utf8');
    const adopted = security.adoptContent({ content: text, kind: 'source', sourceUri: `file:${canonicalPath}`, scope: '.', maxBytes: 4 * 1024 * 1024 });
    if (adopted.provenance.hazards.length > 0 || adopted.provenance.truncated) throw new Error('Project configuration contains unsafe or oversized text.');
    const value: unknown = JSON.parse(text);
    return Object.freeze({ value: parseCodingAgentConfiguration(value), provenance: adopted.provenance });
  } finally { await file.close(); }
}

export function parseCodingAgentConfiguration(input: unknown): CodingAgentConfiguration {
  const value = parseJsonObject(input, { maxDepth: 16, maxCollectionEntries: 10_000, maxStringBytes: 1_000_000, maxTotalBytes: 4_000_000 });
  if (value.version !== 1) throw new Error('Coding Agent configuration must be a version 1 object.');
  if (Object.keys(value).some((key) => !['version', 'provider', 'model', 'reasoning', 'instructions', 'tools', 'authorization', 'verification', 'limits'].includes(key))) throw new Error('Coding Agent configuration contains unknown fields.');
  if (!isCodingAgentProviderId(value.provider) || typeof value.model !== 'string' || value.model.length === 0) throw new Error('Configuration provider/model is invalid.');
  if (!instructionArray(value.instructions)) throw new Error('Workspace instructions must contain confined relative paths.');
  if (!isRecord(value.tools) || Object.keys(value.tools).some((key) => key !== 'enabled') || !stringArray(value.tools.enabled)) throw new Error('Project tool configuration is invalid.');
  const authorization = value.authorization;
  if (!isRecord(authorization) || Object.keys(authorization).some((key) => key !== 'allowedRisks' && key !== 'requireApprovalFor') || !riskArray(authorization.allowedRisks) || !riskArray(authorization.requireApprovalFor)) throw new Error('Project authorization configuration is invalid.');
  const allowedRisks = authorization.allowedRisks;
  const approvalRisks = authorization.requireApprovalFor;
  if (!approvalRisks.every((risk) => allowedRisks.includes(risk))) throw new Error('Approval risks must also be present in authorization.allowedRisks.');
  const verification = value.verification;
  if (!isRecord(verification) || Object.keys(verification).some((key) => key !== 'required' && key !== 'advisory') || !checkArray(verification.required) || !checkArray(verification.advisory)) throw new Error('Verification configuration is invalid.');
  const reasoning = value.reasoning === undefined ? undefined : parseModelReasoningRequest(value.reasoning);
  const limits = value.limits;
  let ownedLimits: CodingAgentLimitConfiguration | undefined;
  if (limits !== undefined) {
    if (!validLimits(limits)) throw new Error('Run limits are invalid.');
    ownedLimits = limits;
  }
  const checkIds = verification.required.map((item) => item.id).concat(verification.advisory.map((item) => item.id));
  if (new Set(checkIds).size !== checkIds.length) throw new Error('Verification check IDs must be unique.');
  return Object.freeze({
    version: 1,
    provider: value.provider,
    model: value.model,
    ...(reasoning === undefined ? {} : { reasoning }),
    instructions: Object.freeze(value.instructions.map((item) => Object.freeze({ path: item.path }))),
    tools: Object.freeze({ enabled: Object.freeze(value.tools.enabled.map((tool) => tool)) }),
    authorization: Object.freeze({ allowedRisks: Object.freeze(allowedRisks.map((risk) => risk)), requireApprovalFor: Object.freeze(approvalRisks.map((risk) => risk)) }),
    verification: Object.freeze({ required: Object.freeze(verification.required.map(snapshotCheck)), advisory: Object.freeze(verification.advisory.map(snapshotCheck)) }),
    ...(ownedLimits === undefined ? {} : { limits: Object.freeze({ ...ownedLimits }) })
  });
}

function snapshotCheck(check: CodingAgentCheckConfiguration): CodingAgentCheckConfiguration {
  return Object.freeze({ id: check.id, command: check.command, ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }), ...(check.maxOutputBytes === undefined ? {} : { maxOutputBytes: check.maxOutputBytes }) });
}

export function isCodingAgentProviderId(value: unknown): value is CodingAgentProviderId { return value === 'ollama' || value === 'openrouter' || value === 'openai' || value === 'openai-codex'; }
function instructionArray(value: unknown): value is readonly CodingAgentInstructionConfiguration[] { return Array.isArray(value) && value.every(item => isRecord(item) && Object.keys(item).every((key) => key === 'path') && relativePath(item.path)); }
function checkArray(value: unknown): value is readonly CodingAgentCheckConfiguration[] { return Array.isArray(value) && value.every(item => isRecord(item) && Object.keys(item).every((key) => ['id', 'command', 'timeoutMs', 'maxOutputBytes'].includes(key)) && typeof item.id === 'string' && item.id.length > 0 && typeof item.command === 'string' && item.command.length > 0 && optionalPositive(item.timeoutMs) && optionalPositive(item.maxOutputBytes)); }
function optionalPositive(value: unknown): boolean { return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0); }
function validLimits(value: unknown): value is CodingAgentLimitConfiguration {
  if (!isRecord(value)) return false;
  const numeric = ['maxConcurrentToolCalls', 'modelTurns', 'totalToolCalls', 'repeatedIdenticalToolCalls', 'elapsedMs', 'promptTokens', 'completionTokens', 'activeImageCount', 'activeImageBytes', 'activeImageTokens', 'consecutiveProviderFailures', 'consecutiveToolFailures', 'providerRetries'];
  if (Object.keys(value).some((key) => ![...numeric, 'knownCost'].includes(key))) return false;
  if (numeric.some((key) => value[key] !== undefined && !optionalPositive(value[key]))) return false;
  return value.knownCost === undefined || (isRecord(value.knownCost) && typeof value.knownCost.amount === 'number' && Number.isFinite(value.knownCost.amount) && value.knownCost.amount > 0 && typeof value.knownCost.currency === 'string' && value.knownCost.currency.trim().length > 0);
}
function riskArray(value: unknown): value is CodingAgentConfiguration['authorization']['allowedRisks'] { return Array.isArray(value) && value.every(item => item === 'read' || item === 'write' || item === 'execute' || item === 'network' || item === 'destructive'); }
function stringArray(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0); }
function relativePath(value: unknown): boolean { return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.split(/[\\/]/u).includes('..'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
