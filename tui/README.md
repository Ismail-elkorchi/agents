# Terminal presentation

Shared terminal presentation for the application adapters. `MarkdownDocument` retains a markspan GFM document session and a width-specific presentation. Source offsets are half-open UTF-16 ranges; generated labels have no source range. Copying original Markdown, displayed text, and normalized code are separate operations.

Links expose only HTTP, HTTPS, and mail destinations and never open automatically. HTML and images remain literal descriptions. Parser resource errors leave the exact source accessible. Syntax highlighting uses Prism's token API; unsupported languages remain plain code.

This package owns no application lifecycle, submissions, proposals, or authorization.

Shared components also provide source-selection copying, attributed note paging, history bookmarks, and retained list measurements for both consumers. Source text stays exact in memory and storage. The installed clipboard API normalizes some text; exact-copy requests detect and report this limitation instead of sending altered content. See [TU02](../terminal-ui-consumer-findings.md).
