import type { PromptContextItemInput } from '@agent-core/runtime';
import type { PendingCommandReportPage } from '@agent-core/tools';

/** Read-only presentation of an already bounded, branch-authorized resource projection. */
export function recoveredCommandContext(page: PendingCommandReportPage): readonly PromptContextItemInput[] {
  if (page.reports.length === 0 && page.complete && !page.oversized) return [];
  const item: PromptContextItemInput = {
    id: 'recovered-command-reports', sourceUri: 'runtime://command-reports/pending', sourceKind: 'external', integrity: 'verified', representation: 'summary',
    mediaType: 'application/json', title: 'Pending command handoffs',
    purpose: 'Unacknowledged handoffs do not establish release commitment or task verification; a receipt may exist if acknowledgement failed. Use resource_reports_read for subsequent pending pages or committed receipts by original runId. Public output artifacts remain separately retrievable.',
    content: JSON.stringify(page)
  };
  if (new TextEncoder().encode(JSON.stringify(item)).byteLength > 16_384)
    throw new RangeError('Recovered command context exceeds its complete envelope budget.');
  return [item];
}
