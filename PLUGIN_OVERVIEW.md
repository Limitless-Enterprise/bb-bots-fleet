Give recurring work a named specialist without tying its identity to one repository.

## What you get

- Named bots with configurable avatars, their own instructions, up to 3,000 characters of `MEMORY.md`, and private structured level-1 memory entries per bot.
- Per-bot defaults for new conversations: harness, model, reasoning, permissions, starter prompt, and checkout or fresh worktree.
- A **Bots** navigation-rail panel with the sidebar tree (bots and conversations) and in-panel `ThreadChat`, plus a rail badge for bot-assigned conversations waiting for input or unread errors (see README § Bots navigation rail).
- Assign unassigned conversations with the experimental **Assign to bot** thread action; inline archive controls on conversation rows.
- Project membership and one optional owner per project to route new conversations. Existing conversation assignments stay intact.
- `@` completion for bot references and attributed asynchronous coordination through `bb bots list` and `bb bots message`, plus a fleet registry CLI (`node`, `create`, `update`, `show`, `tree`, `link`, `unlink`, `release`) for app nodes and bot addresses.

## How it works

Use a bot's `+` to start a conversation in a project it owns, or a personal workspace when it owns none. BB's native composer lets you change the project and machine; a separate action creates a fresh worktree. Edit a bot's instructions, memory, settings, and project roles in one dialog.

Bot state lives in BB's private plugin storage, not in project files. Agents read and update their own state through `bot_read_state` and `bot_update_state`. Mentioning a bot does not send a message or reassign the current conversation by itself.

## Requirements

Requires BB 0.46.1 or newer with Plugin SDK 0.6.77 or newer (nav-panel sidebar, badge, and in-panel chat; BB 0.47.1 ships host SDK 0.6.77) and a configured agent provider. No additional account or external service is required; your provider's normal costs apply. Bot instructions and memory enter the provider's context when its conversations run. Plugins run with BB's full trust; bot membership is not a security boundary. Project-folder creation accepts POSIX paths (including WSL), not native Windows paths.
