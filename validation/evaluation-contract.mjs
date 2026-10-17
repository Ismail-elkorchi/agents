import * as z from 'zod';

const text = z.string().min(1);
const positive = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const relative = text.refine(value => !value.startsWith('/') &&
  !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..'));
const frozen = z.strictObject({ path: text, sha256: hash });
export const taskSchema = z.strictObject({
  format: z.literal('agents.task/1'),
  id: z.string().regex(/^[a-z0-9-]+$/),
  split: z.enum(['development', 'held-out', 'qualification']),
  provenance: z.strictObject({
    description: text,
    exposure: z.enum(['implementation-visible', 'reserved-not-run']),
    sourceCommits: z.array(revision)
  }),
  repositories: z.array(z.strictObject({
    name: z.string().regex(/^[a-z0-9-]+$/),
    revision, tree: revision, snapshot: frozen
  })).min(1),
  instructions: text,
  environment: z.strictObject({
    description: text,
    runtime: z.strictObject({ node: text, nodeSha256: hash, platform: z.literal('linux'), architecture: text }),
    contextTokens: positive.optional(),
    // An offline dependency tree, not a host directory or a shell setup hook.
    overlay: frozen.optional(),
    setup: z.array(text).min(1).optional()
  }),
  network: z.literal('provider-only'),
  limits: z.strictObject({
    wallMs: positive, modelTurns: positive, promptTokens: positive,
    completionTokens: positive, totalToolCalls: positive
  }),
  contextMode: z.enum(['natural', 'reduced-window-stress', 'forced-renewal-stress']),
  checkpoints: z.array(z.strictObject({
    id: text,
    after: z.strictObject({
      type: z.enum(['tool.ended', 'context.transitioned', 'run.completed']),
      toolName: text.optional(),
      occurrence: positive
    }),
    action: z.enum(['steer', 'abort-follow', 'follow']),
    instruction: text
  })),
  constraints: z.strictObject({
    // Exact files or directory prefixes ending in /. Everything else is immutable.
    writable: z.array(text.refine(value =>
      relative.safeParse(value.endsWith('/') ? value.slice(0, -1) : value).success))
  }),
  acceptance: z.array(z.strictObject({
    id: text, description: text,
    verifier: frozen,
    argv: z.array(text).min(1),
    cwd: relative,
    timeoutMs: positive
  })).min(1),
  humanReview: z.array(text)
}).superRefine((task, ctx) => {
  if (new Set(task.repositories.map(repo => repo.name)).size !== task.repositories.length)
    ctx.addIssue({ code: 'custom', message: 'Repository names must be unique.' });
  if (task.split === 'held-out' && task.provenance.exposure !== 'reserved-not-run')
    ctx.addIssue({ code: 'custom', message: 'Implementation-visible tasks are not held out.' });
  if (new Set(task.checkpoints.map(item => item.id)).size !== task.checkpoints.length)
    ctx.addIssue({ code: 'custom', message: 'Checkpoint IDs must be unique.' });
  if (task.contextMode === 'reduced-window-stress' && !task.environment.contextTokens)
    ctx.addIssue({ code: 'custom', message: 'Reduced-window tasks must pin the expected provider context bound.' });
});

export const settingsSchema = z.strictObject({
  provider: z.literal('ollama'),
  model: text,
  reasoning: z.enum(['provider-default', 'none', 'low', 'medium', 'high']),
  maxOutputTokens: positive,
  temperature: z.number().finite(),
  permissions: z.enum(['read_only', 'full_host']),
  tools: z.array(z.enum(['list_directory', 'find_files', 'read_files', 'search_text',
    'view_image', 'read_artifact', 'apply_patch', 'exec_command', 'write_stdin', 'stop_process'])).min(1)
});
export const comparisonSchema = z.strictObject({
  format: z.literal('agents.comparison/1'),
  purpose: z.enum(['machinery-qualification', 'local-model-diagnostic']),
  builds: z.array(z.strictObject({
    label: z.string().regex(/^[A-Za-z0-9-]+$/),
    directory: text,
    sha256: hash
  })).length(2),
  tasks: z.array(text).min(1),
  repetitions: positive,
  concurrency: positive.max(8),
  settings: settingsSchema,
  // There is deliberately no credential or arbitrary endpoint field.
  // Paid gateways require a separately implemented, qualified spending boundary.
  spending: z.strictObject({ mode: z.literal('no-paid-calls') })
});

export const normalTools = ['list_directory', 'find_files', 'read_files', 'search_text',
  'view_image', 'read_artifact', 'apply_patch', 'exec_command', 'write_stdin', 'stop_process'];

export function schedule(comparison, tasks) {
  const result = [];
  for (const task of tasks)
    for (let repetition = 1; repetition <= comparison.repetitions; repetition++) {
      const order = repetition % 2 ? comparison.builds : [...comparison.builds].reverse();
      result.push({ task, repetition, order });
    }
  return result;
}
