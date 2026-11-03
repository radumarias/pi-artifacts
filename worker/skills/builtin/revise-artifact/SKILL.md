---
name: revise-artifact
description: Use when the user wants to change, fix, restyle or extend a page already published in this chat, compare its versions, or go back to an earlier version.
allowed-tools: artifact_read artifact_history artifact_diff artifact_write artifact_check artifact_drafts artifact_publish
---
Change the page the user has, not a page you remember.

1. Read the current version with artifact_read before editing, even if you wrote it earlier in the chat. Keep its manifest unless the change needs another tool.
2. Make the smallest change that does what was asked. Keep the layout, the loading, error and "updated" states, and the live data calls that already work.
3. Save the change with artifact_write: the artifact_id and edits to its latest version for just what changes, not the whole page. Keep the manifest it declares unless the change needs another tool; then declare in mcp every server and tool the page still calls.
4. Check the draft it gives with artifact_check and a test of what you changed. Fix what it finds with artifact_write, that draft_id and edits, and check the new draft, until it passes. Each page you write is kept as a draft: artifact_drafts gets an earlier attempt back if a fix went wrong.
5. Publish the draft that passed by its draft_id, with the same artifact_id and a one-line message saying what changed.
6. To go back to an earlier version, write it as a draft with artifact_write, the artifact_id and that version and no edits, check it and publish it as a new version with a message such as "Restore v3". Versions are never deleted.
7. When asked what changed, use artifact_history and artifact_diff instead of guessing.

Guardrails:
- Never replace live data calls with values copied from a tool result.
- If a change would widen what the page can call (a new server, or a tool that writes), say so in your reply.
- If the request is ambiguous ("make it better"), pick one concrete improvement, make it, and say what you chose.
