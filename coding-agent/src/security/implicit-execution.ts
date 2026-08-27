export type ImplicitExecutionSurface =
  | 'package_lifecycle_script'
  | 'test_discovery'
  | 'compiler_plugin'
  | 'git_hook'
  | 'git_configuration'
  | 'external_diff_driver'
  | 'text_conversion_driver'
  | 'filesystem_watcher'
  | 'build_tool'
  | 'generated_executable'
  | 'environment_loader';

export interface ImplicitExecutionClassification {
  readonly surface: ImplicitExecutionSurface;
  readonly kind: 'sandboxed_effect';
  readonly explanation: string;
}

const explanations: Readonly<Record<ImplicitExecutionSurface, string>> = Object.freeze({
  package_lifecycle_script: 'Package installation and task invocation may execute repository-defined lifecycle programs.',
  test_discovery: 'Test enumeration may import or execute repository modules.',
  compiler_plugin: 'Compiler and language plugins are repository-selected executable code.',
  git_hook: 'Git hooks are executable repository or user configuration.',
  git_configuration: 'Git configuration may activate aliases, includes, credential helpers, filters, and external programs.',
  external_diff_driver: 'External diff drivers execute configured programs.',
  text_conversion_driver: 'Text conversion filters execute configured programs.',
  filesystem_watcher: 'Watchers keep repository-selected processes active after the initiating command.',
  build_tool: 'Build tools execute repository-controlled programs and plugins.',
  generated_executable: 'Generated binaries and scripts are untrusted executable content.',
  environment_loader: 'Environment loaders may execute code or expose secrets to a child process.'
});

export function classifyImplicitExecution(surface: ImplicitExecutionSurface): ImplicitExecutionClassification {
  return Object.freeze({ surface, kind: 'sandboxed_effect', explanation: explanations[surface] });
}

export const implicitExecutionSurfaces: readonly ImplicitExecutionSurface[] = Object.freeze(Object.keys(explanations) as ImplicitExecutionSurface[]);
