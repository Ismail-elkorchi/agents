export interface GitRepositoryLocation {
  readonly workspaceRoot: string;
  readonly gitDirectory: string;
  readonly commonDirectory?: string;
}

export interface GitStatusEntry {
  readonly path: string;
  readonly state: string;
}

export interface GitObservationReceipt {
  readonly executionId: string;
  readonly requestDigest: string;
  readonly policyDigest: string;
  readonly executionDigest: string;
  readonly backend: string;
  readonly backendVersion: string;
  readonly executableIdentityDigest?: string;
  readonly executableContentSha256?: string;
}

export type GitRepositoryObservation =
  | {
      readonly kind: 'observed';
      readonly branch?: string;
      readonly head?: string;
      readonly entries: readonly GitStatusEntry[];
      readonly totalEntries: number;
      readonly omittedEntries: number;
      readonly coverage: 'complete' | 'partial';
      readonly receipt: GitObservationReceipt;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'sandbox_unavailable' | 'execution_rejected' | 'execution_unknown' | 'execution_expired' | 'status_failed' | 'output_invalid';
      readonly executionId?: string;
    };

export interface GitRepositoryObserver {
  observe(location: GitRepositoryLocation, signal?: AbortSignal): Promise<GitRepositoryObservation>;
  close(): Promise<void>;
}

export function unavailableGitRepositoryObserver(): GitRepositoryObserver {
  return Object.freeze({
    observe: () => Promise.resolve(Object.freeze({ kind: 'unavailable', reason: 'sandbox_unavailable' })),
    close: () => Promise.resolve()
  });
}
