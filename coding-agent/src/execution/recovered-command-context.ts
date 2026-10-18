import type { ArtifactRepository } from '@agent-core/persistence';
import type { PromptContextItemInput } from '@agent-core/runtime';
import type { CommandExecutionReport } from '@agent-core/tools';

/** Presentation bounds never discard the recoverable command reports. */
export async function recoveredCommandContext(
  reports: readonly CommandExecutionReport[],
  ownerId: string,
  artifacts: ArtifactRepository
): Promise<readonly PromptContextItemInput[]> {
  const records = reports.filter(({ result }) => result.owner.ownerId === ownerId).map(({ result, settlementReference, terminalOutput, terminalDiagnostic }) => ({
    processId: result.processId,
    owner: result.owner,
    status: result.status,
    cursorEnd: result.cursorEnd,
    ...(terminalOutput ? { terminalOutput } : {}),
    ...(terminalDiagnostic === undefined ? {} : { terminalDiagnostic }),
    ...(result.diagnostic === undefined ? {} : { recoveryDiagnostic: result.diagnostic }),
    ...(result.finalizationPending ? { finalizationPending: true } : {}),
    exitCode: result.exitCode,
    signal: result.signal,
    artifact: result.artifact,
    originalOutput: result.originalOutput,
    ...(settlementReference ? { settlementReference } : {})
  }));
  if (records.length === 0) return [];
  const artifact = await artifacts.store({
    label: 'Recovered command reports', mediaType: 'application/json',
    content: new TextEncoder().encode(JSON.stringify(records)),
    description: 'Complete recovered command report metadata for this resource owner; output artifacts are linked separately.'
  });
  const selected = [];
  let bytes = 0;
  for (const record of records) {
    const size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if (selected.length >= 16 || bytes + size > 16_384) break;
    selected.push(record);
    bytes += size;
  }
  return [{
    id: 'recovered-command-reports', sourceUri: `artifact:${artifact.artifactId}`,
    sourceKind: 'external', integrity: 'verified', representation: 'summary',
    mediaType: 'application/json', title: 'Recovered command reports',
    purpose: 'Recovered execution facts, separate from task verification. Read the complete metadata artifact with read_artifact; output artifacts retain original output.',
    content: JSON.stringify({
      coverage: { total: records.length, included: selected.length, omitted: records.length - selected.length,
        order: 'recovery-enumeration', complete: selected.length === records.length },
      reports: selected, completeReports: artifact
    })
  }];
}
