# SEC0 — Workspace trust, provenance, egress, and private state

**Intent:** Prevent repository-controlled data from silently becoming product authority or sensitive provider input.

**Work:** Implement the three trust states and action matrix above. The human or organization policy owns transitions; trust is stored privately outside the workspace against canonical identity and is revocable. No project file can change it.

Define a provenance envelope used by prompt construction, instructions, tool evidence, checkpoints, receipts, diagnostics, and summaries. Add a provider-egress manifest, default sensitive-path/content exclusions, bounded redaction, retention/deletion controls, and private state permissions.

Inventory implicit execution surfaces: package lifecycle scripts, task/test enumeration and discovery, compiler/language plugins, build tools, Git hooks and configuration, external diff/textconv drivers, environment auto-loading, file watchers, generated executables, and commands labelled read-only. Classify each as data inspection or an exact sandboxed effect.

**Acceptance:**

- A new or identity-changed workspace starts `untrusted`; only the owner can move it to `restricted` or `trusted`.
- The action matrix is enforced at the capability boundary, not only hidden in the UI.
- Project configuration can narrow the authority ceiling but cannot grant a risk, sandbox guarantee, egress path, or trust transition.
- Scoped instructions and every context item retain origin/scope/hash/trust attribution; repository content cannot masquerade as user/system policy.
- Secret fixtures, outside-root aliases, `.git`, private state, terminal controls, bidi controls, hostile filenames, tool output, checkpoints, errors, and transcripts pass redaction/provenance tests.
- State permissions, cleanup, retention, and deletion are verified cross-platform where supported.
