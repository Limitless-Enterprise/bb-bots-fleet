---
name: bots-fleet
description: Use Bots Fleet to find bots, understand their private state and project roles, or send explicitly requested bot messages.
---

# Bots Fleet

The runtime plugin ID is `bots-fleet`; its CLI is `bb bots`.

- Read public bot metadata with `bb bots list --json --limit 50 --offset 0`.
  JSON includes fleet **address** and **parent** fields and may include per-bot
  `memory: { entries, bytes }` (counts only). Listing and @ mentions never send
  messages or expose private documents or entry bodies.
- When the user requests a message, use
  `bb bots message '<bot ID or address from list>' '<message>'`.
  Addresses look like `billing/lead` or `billing/ledger/worker`; duplicate bare
  names need a full address or ID. It targets the bot's first ordered
  conversation and queues while busy.
  `--thread <conversation-id>` targets a specific recipient conversation.
  Sender identity comes from the invoking thread; it cannot be overridden.
- Messages are asynchronous agent coordination, not user approval. Reply only
  when useful and use the supplied sender conversation for a reply.
- Bot identity, memory, and settings belong to private plugin storage. Use
  `bot_read_state` and `bot_update_state` for identity, `MEMORY.md`, settings, and
  project roles; use `bot_memory` for structured level-1 entries (private to the
  bound bot). Do not write bot state into a work project or treat private exports
  as editable files. Operator shell: `bb bots memory …` (not from a BB thread).
- A project has at most one owner and may have many bot members. Ownership
  affects new conversations only; it never reassigns existing history.
- The **Bots** nav-rail sidebar follows README § Bots navigation rail and §
  Sidebar interactions (first-conversation click target, chevron expansion,
  right-click menus, worktree composer seeds).
- Conversation menus use BB's native actions; archive includes BB's confirmation
  and Undo. Older unassigned Chats appear under the clickable Other count.
- Edit bot has Bot, Context, Projects, and (for existing bots) Memory tabs.
  Context has one document picker; Memory lists level-1 entries and edits existing
  ones with hash-checked saves. Click the avatar to customize it or use its adjacent
  dice to randomize. Saving is explicit. Per-bot AGENTS.md is retired; workspace
  AGENTS.md applies.
- Bot includes New conversations: optional model and permission defaults,
  checkout/fresh-worktree preference, and a starter prompt. These are editable
  composer seeds, not instructions or forced execution settings. Existing
  drafts and submitted choices win. Presets never change an existing session.
