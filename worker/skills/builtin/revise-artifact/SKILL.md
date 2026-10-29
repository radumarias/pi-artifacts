---
name: revise-artifact
description: Use when the user wants to change, fix, restyle or extend a page already published in this chat, compare its versions, or go back to an earlier version.
allowed-tools: artifact_read artifact_history artifact_diff artifact_publish
---
Change the page the user has, not a page you remember.

1. Read the current version with artifact_read before editing, even if you wrote it earlier in the chat. Keep its manifest unless the change needs another tool.
2. Make the smallest change that does what was asked. Keep the layout, the loading, error and "updated" states, and the live data calls that already work.
3. Publish with the same artifact_id, the full page, and a one-line message saying what changed. Declare every server and tool the page still calls.
4. To go back to an earlier version, read that version with artifact_read and publish it again as a new version with a message such as "Restore v3". Versions are never deleted.
5. When asked what changed, use artifact_history and artifact_diff instead of guessing.

Guardrails:
- Never replace live data calls with values copied from a tool result.
- If a change would widen what the page can call (a new server, or a tool that writes), say so in your reply.
- If the request is ambiguous ("make it better"), pick one concrete improvement, make it, and say what you chose.
