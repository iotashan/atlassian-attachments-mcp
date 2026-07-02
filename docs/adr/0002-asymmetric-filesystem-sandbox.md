# Asymmetric filesystem sandbox: downloads confined, uploads unrestricted

Attachment filenames and bodies are attacker-controlled (anyone who can touch a ticket), and prompt injection in ticket text can steer an agent running auto-approved tools. Downloads are therefore confined to a Sandbox Root; uploads may read any path the process can read.

**Downloads (writes):** confined to `ATTACHMENT_MCP_DIR` if set, else `<cwd>/.claude/attachments/` when cwd looks like a real workspace, else the per-user cache dir (`~/Library/Caches/atlassian-attachments-mcp/`, XDG equivalent on Linux, `%LOCALAPPDATA%` on Windows). The server writes a one-line `*` `.gitignore` into any directory it creates, so the sandbox never pollutes a repo regardless of where it lands. Layout: `<root>/<site-host>/<container-key>/<attachmentId>-<sanitized-filename>` — attachment-ID prefix makes collisions structurally impossible; the site level keeps two server instances sharing one root from cross-colliding. Filenames and container keys are sanitized (separators, `..`, control chars, Windows reserved names, length caps). Containment is enforced via realpath-then-prefix checks (parent realpath for not-yet-existing targets); symlinks inside the sandbox are rejected outright. No overwrite without `overwrite:true`; collisions return a structured error with a suggested deduped path.

**Uploads (reads):** unrestricted. The driving use cases — images pasted into a prompt (which land in OS temp dirs), screenshot directories, `~/Downloads` — are all outside any project tree, and the MCP host's own permission model already governs what a session may read. A three-way model panel split here (Codex argued for symmetric confinement as an anti-exfiltration boundary in auto-approve setups); the maintainer chose usability and accepts the residual exfiltration risk, which README documents.

## Consequences

- The server never writes outside the Sandbox Root; relative tool paths resolve against it, never process cwd.
- Attacker-supplied filenames are never echoed as usable paths in tool output — only sanitized, sandbox-relative paths, with original names in labeled metadata.
- Max-size guard and streaming writes protect against oversized bodies; zip-slip validation is reserved for any future extract feature.
