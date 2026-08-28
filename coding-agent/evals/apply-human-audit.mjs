import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyHumanAuditDecisions,
  renderCampaignReport,
  validateCampaign
} from './evaluation.mjs';

const options = parseArguments(process.argv.slice(2));
const campaignDirectory = path.resolve(options.campaign);
const campaignPath = path.join(campaignDirectory, 'campaign.json');
const campaign = JSON.parse(await readFile(campaignPath, 'utf8'));
validateCampaign(campaign);
const auditSample = JSON.parse(await readFile(confinedPath(campaignDirectory, campaign.auditArtifacts.sample.path), 'utf8'));
const auditEvidence = JSON.parse(await readFile(confinedPath(campaignDirectory, campaign.auditArtifacts.evidence.path), 'utf8'));
const decisions = JSON.parse(await readFile(path.resolve(options.decisions), 'utf8'));
const applied = applyHumanAuditDecisions({ campaign, auditSample, auditEvidence, decisions });

await writeImmutableJson(confinedPath(campaignDirectory, applied.samplePath), applied.auditSample);
await writeImmutableJson(confinedPath(campaignDirectory, applied.decisionPath), decisions);
await writeAtomic(path.join(campaignDirectory, 'report.md'), renderCampaignReport(applied.campaign));
await writeAtomic(campaignPath, `${JSON.stringify(applied.campaign, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  campaignId: applied.campaign.campaignId,
  auditStatus: applied.campaign.auditStatus,
  selectedRuns: applied.campaign.auditSelection.length,
  pendingRuns: applied.campaign.records.filter((record) => record.humanAudit.status === 'selected-pending').length,
  disputedRuns: applied.campaign.records.filter((record) => record.outcome === 'disputed').length,
  decisionDigest: applied.decisionDigest
}, null, 2)}\n`);

async function writeImmutableJson(target, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(target, serialized, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST' || await readFile(target, 'utf8') !== serialized) throw error;
  }
}

async function writeAtomic(target, value) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
}

function confinedPath(root, relativePath) {
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Campaign artifact path escapes its directory: ${relativePath}`);
  return target;
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (name === '--campaign' && value) { parsed.campaign = value; index += 1; }
    else if (name === '--decisions' && value) { parsed.decisions = value; index += 1; }
    else throw new Error(`Unknown or incomplete human-audit argument: ${name ?? '<missing>'}`);
  }
  if (typeof parsed.campaign !== 'string') throw new Error('--campaign is required.');
  if (typeof parsed.decisions !== 'string') throw new Error('--decisions is required.');
  return parsed;
}
