import { createSandbox } from '@ismail-elkorchi/sandbox';
import {
  filesystemResource,
  isolatedPath,
  isolatedPolicy,
  systemRuntimeResources,
  WORKSPACE_ACCESS
} from '../../dist/execution/sandbox-policy.js';

export { filesystemResource, isolatedPath, isolatedPolicy, WORKSPACE_ACCESS };

export const sandboxAvailable =
  process.platform === 'linux' &&
  (await (async () => {
    const sandbox = await createSandbox();
    try {
      const support = await sandbox.probe({
        isolation: { kind: 'process' },
        policy: isolatedPolicy(await systemRuntimeResources(), 1_000),
        requirements: {}
      });
      return support.implementations.some(
        (implementation) => implementation.eligibility.state === 'eligible'
      );
    } finally {
      await sandbox.dispose();
    }
  })());

export async function commandRun(workspace, command, timeoutMs = 1_000) {
  return {
    isolation: { kind: 'process' },
    policy: isolatedPolicy(
      [
        ...(await systemRuntimeResources()),
        filesystemResource('workspace', workspace, '/workspace', WORKSPACE_ACCESS)
      ],
      1_000
    ),
    requirements: {},
    resources: {
      wallTime: { enforcement: 'hard', scope: 'process', value: timeoutMs },
      output: { enforcement: 'hard', scope: 'process', value: 1024 * 1024 }
    },
    process: {
      executable: isolatedPath('/bin/sh'),
      args: ['-c', command],
      cwd: isolatedPath('/workspace'),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    }
  };
}

const implementation = {
  id: 'fixture',
  version: '1',
  buildId: 'fixture',
  conformanceManifestId: 'fixture',
  stability: 'stable'
};
export const enforcement = {
  boundary: { kind: 'os-process' },
  implementation: { ...implementation, mechanism: [] },
  host: { platform: 'linux', architecture: 'x64', pathStyle: 'posix' },
  target: { operatingSystem: 'linux', pathStyle: 'posix' },
  guarantees: [],
  caveats: [],
  filesystem: { kind: 'isolated', resourceManifestDigest: '4'.repeat(64), visibleRoots: ['/workspace'] }
};

export function authorizationSummary(executable = '/bin/sh', args = ['-c', 'printf sandboxed']) {
  const policy = isolatedPolicy([], 1_000);
  return {
    isolation: { kind: 'process' },
    implementation,
    filesystem: {
      kind: 'isolated',
      resourceManifestDigest: '4'.repeat(64),
      resources: [],
      masks: [],
      privateHomePath: isolatedPath('/home/sandbox'),
      temporaryPath: isolatedPath('/tmp')
    },
    network: { mode: 'none', topology: 'private-namespace' },
    process: policy.process,
    ipc: policy.ipc,
    resources: Object.fromEntries(
      Object.entries({ wallTime: 1000, output: 1024, openFiles: 256, singleFileSize: 1024 * 1024 }).map(
        ([key, value]) => [key, { enforcement: 'hard', scope: 'process', value }]
      )
    ),
    execution: {
      executable: isolatedPath(executable),
      executableIdentityDigest: '5'.repeat(64),
      executableContentSha256: '6'.repeat(64),
      args,
      cwd: isolatedPath('/workspace'),
      cwdIdentityDigest: '7'.repeat(64),
      environmentNames: [],
      sensitiveEnvironmentNames: [],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    }
  };
}
