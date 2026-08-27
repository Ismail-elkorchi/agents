# SEC0 evidence

Status: done

## Decisions

- Workspace trust is a Coding Agent application policy with three levels: `untrusted`, `restricted`, and `trusted`. It never replaces tool authorization, root confinement, sandbox enforcement, or provider policy.
- Canonical identity includes the platform, canonical root path, device, inode, and mount identity of the exact adopted `WorkspaceFileRoot`. Moving a root, replacing it at the same path, or using a separate worktree produces a new identity and starts untrusted. Multi-root workspaces are not supported. Git remotes are content and do not determine authority.
- Trust is written only from an explicit user/organization decision and stored in a checksummed private record outside the repository. Missing, deleted, corrupt, or identity-mismatched records do not grant trust.
- Repository instructions and configuration remain untrusted attributed content in every trust level. Restricted/trusted changes which application policy may consider them, not whether they are factual or authoritative.
- Sensitive workspace paths are denied independently from provider request scanning. Provider egress blocks untrusted workspaces, bounded-size violations, common credential/private-key material, and records a request digest receipt before I/O.
- Package scripts, test discovery, compiler plugins, Git hooks/configuration, diff/text conversion drivers, watchers, build tools, generated executables, and environment loaders are all classified as executable effects; labels such as “test” or “read-only” do not turn them into inspection.

## Implemented contracts

- Agent Core `44c5e19b85a755609697b36b83c36066a021df25` exposes the stable identity of an adopted root and transfers the exact same root capability into `LocalToolHost`; no second path adoption can diverge from the authority whose identity was trusted.
- Agents `326661d7780aacca3052c5e30823af4fa9df8435` adds canonical workspace identity, trust decisions and action matrix, a workspace security boundary, content provenance with source/scope/hash/trust/truncation/hazard data, sensitive-path policy, provider-egress admission, bounded redaction, an implicit-execution inventory, private state storage, checksummed trust records, and project-authority narrowing.
- Restricted workspaces require approval for mutation, command, network, and watcher effects. Untrusted workspaces block provider egress and every non-inspection action. Trusted workspaces remain subject to all independent authority ceilings.
- Terminal, bidi, invisible, and invalid Unicode content is represented visibly before use as attributed workspace content. Sensitive redaction is bounded and removes terminal/bidi controls from diagnostics and summaries that use the boundary.

## Verification

- `npm run build` and `npm run lint` passed.
- `coding-agent/test/workspace-security.test.js` covers physical-root replacement, private/checksummed/revocable trust records, invalid identity, the action matrix, sensitive paths, authority narrowing, deceptive Unicode/control text, egress denial before provider I/O, redaction, and the complete implicit-execution inventory.
- C0 consumer composition and Writing Agent neutrality tests pass with the transferred root authority.
- Agent Core `npm run verify:release` passed at `44c5e19b85a755609697b36b83c36066a021df25`: 310 unit/security/property-style tests, 146 focused tests, build, lint, declaration variants, and packed consumer.
- Agents `npm run verify:release` passed at `326661d7780aacca3052c5e30823af4fa9df8435`: plan validation, build, lint, 34 unit/security tests, and packed consumers.

## Integration ownership

- A1 consumes private state and project-proposal contracts and removes repository-local state.
- A2 consumes attributed content for repository orientation and instructions.
- A3 composes the trust tool boundary with the user authority ceiling and the sandbox execution target.
- Those nodes may not recreate or bypass the SEC0 authority; this node owns the shared application security contract they consume.
