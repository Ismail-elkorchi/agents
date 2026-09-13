import type { JsonObject } from '@agent-core/json';
import type { ToolCall } from '@agent-core/tools';

export function toolLabel(call: ToolCall): string {
  const value = call.input.kind === 'json' ? call.input.value : undefined;
  switch (call.name) {
    case 'exec_command':
      return `Run ${quoted(firstString(value, ['command']) ?? 'command')}`;
    case 'write_stdin':
      return `Continue ${compactTarget(value, ['processId'])}`;
    case 'stop_process':
      return `Stop ${compactTarget(value, ['processId'])}`;
    case 'apply_patch':
      return 'Apply workspace patch';
    case 'read_files':
      return `Read ${compactTarget(value, ['files', 'path'])}`;
    case 'search_text':
      return `Search for ${quoted(firstString(value, ['query']) ?? 'text')}`;
    case 'list_directory':
      return `List ${compactTarget(value, ['path'])}`;
    case 'find_files':
      return `Find ${compactTarget(value, ['patterns'])}`;
    case 'view_image':
      return `View ${compactTarget(value, ['path'])}`;
    case 'read_artifact':
      return `Read ${compactTarget(value, ['artifactId'])}`;
    default:
      return humanize(call.name);
  }
}

function compactTarget(value: JsonObject | undefined, keys: readonly string[]): string {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
    if (Array.isArray(candidate)) {
      const paths = candidate.filter((item): item is string => typeof item === 'string');
      if (paths.length > 0)
        return paths.length === 1 ? (paths[0] ?? 'workspace') : `${String(paths.length)} paths`;
    }
  }
  return 'workspace';
}

function firstString(value: JsonObject | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return compact(candidate);
  }
  return undefined;
}

function quoted(value: string): string {
  return `“${bounded(value.replaceAll('\n', ' '), 72)}”`;
}

function compact(value: string): string {
  return bounded(value.trim().replaceAll(/\s+/g, ' '), 180);
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function humanize(value: string): string {
  const words = value.replaceAll('_', ' ').trim();
  return words.length === 0 ? 'Tool' : `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
}
