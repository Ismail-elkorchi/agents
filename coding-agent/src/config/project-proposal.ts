import type { ToolRisk } from '@agent-core/tools';
import type { WorkspaceContentProvenance } from '../security/content-provenance.js';

export interface ProjectConfigurationProposal<T> {
  readonly value: T;
  readonly provenance: WorkspaceContentProvenance;
}

export function narrowRiskCeiling(ceiling: readonly ToolRisk[], proposed: readonly ToolRisk[]): readonly ToolRisk[] {
  const ceilingSet = new Set(ceiling);
  if (proposed.some((risk) => !ceilingSet.has(risk))) throw new Error('Project configuration cannot grant authority absent from the user or organization ceiling.');
  return Object.freeze([...new Set(proposed)]);
}
