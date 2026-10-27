# Bots Fleet

## Origin and attribution

This plugin is a fork of [tobi/bb-bots-sidebar](https://github.com/tobi/bb-bots-sidebar)
at commit `d54ae23` (release 1.0.0). Limitless Enterprise maintains it as **Bots
Fleet**. Track upstream through the `upstream` git remote. The upstream repository
currently publishes no licence file (**licence status: pending owner decision**).
Agent Fleet design docs ([ADR 0006](https://github.com/Limitless-Enterprise/srs/blob/main/agent-fleet/03-architecture/adrs/0006-bots-fleet-fork-and-rename.md),
[Fleet CLI LLD §8](https://github.com/Limitless-Enterprise/srs/blob/main/agent-fleet/03-architecture/low-level-design-bots-cli.md))
require upstream attribution here; [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
covers bloub only.

Requires BB 0.46.1 or newer (Plugin SDK 0.6.77 or newer; BB 0.47.1 ships host SDK 0.6.77). Conversation menus and archive
buttons use BB's native thread actions, including confirmation, Undo, and actions
from other plugins. Rows follow native titles, links, draft indicators, plugin
statuses, and keyboard shortcuts. Provider session options from the native new
conversation composer are preserved when starting a bot conversation.

Bots are identities, not projects or working directories. A bot has a name,
avatar, operating instructions, memory, and linked projects. Its state stays
private in BB and follows its conversations through embedded instructions and
bot-scoped tools.

New conversations default to a project the bot owns, or to a personal workspace
when it owns none. Explicit project/worktree starts can choose any available work
project and join the selected bot to it. Creating a bot never creates a
backing BB project or writes `SOUL.md` into a repository.

## New conversation defaults

In **Edit bot → Bot → New conversations**, choose an optional preferred
harness, model, reasoning level, and service tier using BB's native picker.
Permissions follow the project unless you enable **Custom permissions**, which
shows a note that **full** isn't allowed for bots. Saved presets allow
**accept-edits** or **auto** only; **full** is rejected on bot create/update,
RPC validation, and `bb bots` `--permission`. Rows that still store **full** load
with custom permissions cleared and surface a refresh warning until you save
again. The pickers use the selected machine's live capabilities;
BB reconciles unsupported selections when opening the composer.

Choose **Fresh worktree** to make the bot's + start a new worktree when it owns
a project. Without an owned project, + still opens a personal conversation.
Explicit project/worktree actions keep their requested environment, and forks
keep their existing behavior. A **Starter prompt** prefills an empty new-chat
draft; it never sends automatically or replaces an existing draft.

Defaults are private bot metadata, saved with the rest of the editor in one
revision-checked transaction. Existing bots inherit project defaults. The
composer captures defaults when opened and remains editable; later refreshes
cannot reset a draft, and the server never reapplies a preset over your submitted
choices. Provider-specific session options remain available in the composer;
saved presets do not override them.

## Preview

[Open the screenshot gallery](docs/screenshots/index.html). All illustrations use
synthetic data; private-session captures do not belong in published assets.

Demo data only: [Bots rail panel](docs/screenshots/sidebar.png) (sidebar + in-panel chat) ·
[Activity badge](docs/screenshots/bot-activity.png) ·
[Bot new-conversation action](docs/screenshots/bot-new-chat-hover.png) ·
[Hover archive](docs/screenshots/conversation-hover.png) ·
[Conversation reorder](docs/screenshots/conversation-drop.png) ·
[Create bot](docs/screenshots/bot-create.png) ·
[Edit bot](docs/screenshots/bot-editor.png) ·
[Project roles](docs/screenshots/bot-projects.png) ·
[Create menu](docs/screenshots/create-menu.png) ·
[Project during bot creation](docs/screenshots/bot-new-project.png) ·
[State in Edit bot](docs/screenshots/bot-state.png) ·
[Appearance choices](docs/screenshots/bot-appearance.png)

## Private state

The plugin's SQLite database is the durable authority. Generated Markdown/JSON
exports live under the plugin's own BB data directory at `state/<bot-id>/`, with
private directory/file permissions. They are keyed by stable bot IDs, not names,
and are not execution workspaces. Agents do not need their physical locations.

| Logical file | Purpose |
| --- | --- |
| `SOUL.md` | Identity and personality; up to 4,096 characters |
| `MEMORY.md` | Durable facts and preferences; at most 3,000 characters |
| `settings.json` | Structured bot preferences; a JSON object up to 16,384 characters |

Structured **level-1 memory** (private SQLite entries keyed by bot ID) is separate
from `MEMORY.md`. Each live entry has a title, kind, importance, and body (at most
4,000 characters); a bot may hold at most 300 live entries. Private JSON exports for
live entries and revision history mirror under `state/<bot-id>/memory/` in the plugin
data directory. Only the bound bot can read or change its level-1 memory through
`bot_memory`; other bots and unassigned conversations cannot access it.

**Edit bot** has **Bot**, **Context**, **Projects**, and (for existing bots)
**Memory** tabs. Context has one document picker for SOUL.md, MEMORY.md, and
settings.json. **Memory** lists private level-1 entries and lets you load and
edit an existing entry with hash-checked saves (no create or forget in the UI).
Click the avatar for appearance controls, or the small dice beside it to
randomize its appearance. Its explicit Save commits Bot/Context/Projects changes
together with revision/hash checks; invalid JSON or conflicts never partially save
other fields. Level-1 entry saves use the Memory tab's per-entry Save. Use this
editor or the state tools—not direct edits to exports.
Export failures do not lose committed state or prevent conversations.
The working machine can be offline while state is still readable/editable in BB.

Sessions receive fixed tool/storage guidance, a bounded SOUL excerpt, and the full
current memory (up to 3,000 characters). There is no per-bot AGENTS instruction
layer. Old bot AGENTS text remains archived in private storage and is not injected,
editable, or newly exported. Existing oversized memories remain readable without
truncating stored data; condense them before writing memory again. Existing provider sessions pick up changed system
instructions when they are reconstructed; tool reads always see current state.
The current project's own `AGENTS.md` continues to apply. Bot state is never
copied into that project's directory.

## Project roles

**Edit bot → Projects** shows only the bot's linked projects. Use **Add existing…**
to search for a project, **New project…** to create one, or **×** to unlink.
Each linked project has a **Member / Owner** selector.
Projects may have many members but only one owner. Claiming an already-owned
project is rejected; release its current ownership before assigning another bot.

- **Owner:** new ordinary project conversations default to this bot.
- **Member:** an explicitly selected bot, or inherited parent/fork bot context,
  overrides that default. Starting under a bot joins it to the selected project
  if needed, without changing the project's owner.
- Existing conversations and main pointers never move. Ownership does not capture
  older unassigned conversations, including ones still waiting for their first send.
- Releasing ownership keeps membership. Leaving also releases ownership, without
  changing existing conversation bindings. Projectless chats stay projectless;
  personal and legacy bot-home projects cannot be owned.

Ownership is conversation routing, not filesystem ownership or an access-control
change. Existing memberships are **not** promoted automatically; choose Owner to
opt in. Role changes are atomic and survive reloads.

## Creating bots, sections, and projects

The **+** in the Bots header opens **Bot / Section / Project**. Standalone project
creation opens that work project without creating a bot.

You can also create a work project directly inside a new or existing bot's
**Projects** tab. Choose a machine and folder (or use **Browse…**). Missing folders
are created; existing files are not changed. The new project is selected as
**Owner** in the bot draft; click **Create bot / Save bot** to save that link.

**Create project** is an explicit, immediate action. Cancelling the bot afterwards
does not delete that project or its files. Unsaved project forms create nothing.
Retries retain the same request ID to avoid duplicate projects. Existing folder
registrations are rejected rather than silently reused. Bot state stays private
in BB; a bot still needs no project or special working directory.

## State tools

- `bot_read_state({ target })` reads identity, memory, settings, or project roles.
- `bot_update_state({ target, action, ... })` is the durable-write gateway for
  identity, `MEMORY.md`, settings, and project membership.
- `bot_memory({ action, ... })` manages private structured level-1 entries for the
  bound bot only (list, read, search, write, forget).

| `bot_memory` action | Inputs / behavior |
| --- | --- |
| `list` | Optional `kind` filter and `limit` (default 50, max 100); returns index lines with id, title, kind, importance, hook, reviewBy, updatedAt |
| `read` | Entry `id`; returns full entry including body and sha256 |
| `search` | `query` (substring match on title/body) and optional `limit` (default 20, max 50) |
| `write` | `title`, `kind` (`fact`, `preference`, `decision`, `procedure`, `episode`, `reference`), `importance` (0–100), `body`; optional `reviewBy`. Omit `id` to create. To update, supply `id` and fresh `expectedSha256` from a read |
| `forget` | Entry `id` and fresh `expectedSha256` from a read |

Level-1 writes use SQLite transactions with the same per-bot serialization as
`bot_read_state` / `bot_update_state`. Updates and forgets require a current sha256;
conflicts ask you to read again. Creating an entry when the bot already has 300 live
entries fails with a clear limit error.

| Target | Action | Inputs / behavior |
| --- | --- | --- |
| `identity` | `set` | Fresh `expectedRevision`, plus name, role, and/or soul |
| `memory` | `append`, `forget` | One exact single-line `fact`; append deduplicates; resulting memory must fit 3,000 characters |
| `memory` | `overwrite` | Full replacement `content` (max 3,000 characters) and fresh `expectedSha256` from a memory read; no retry on conflict |
| `settings` | `set` | `values` merges selected top-level keys |
| `settings` | `unset` | `keys` removes only those keys |
| `project` | `join`, `leave` | Existing `projectId`; leave also releases ownership |
| `project` | `own`, `release` | Claim an unowned project (also joins), or release ownership while remaining a member |

For example:

```json
{"target":"memory","action":"append","fact":"The user prefers concise progress updates."}
```

All operations are scoped to the current bot. Tools cannot choose another bot or
an arbitrary path. Writes use SQLite transactions and expected hashes/revisions;
semantic memory/settings changes retry bounded conflicts against current state.
Memory reads include full content, sha256, characters, and maxCharacters. If memory
is full, read it, condense it, then overwrite with that hash. Whole-memory overwrites
never retry against a newer document; read and merge again after a conflict.
Fixed guidance uses BB’s static tool-instructions field. Dynamic identity/memory
stays within BB’s 4,096-character limit, retaining full compliant memory and
shortening the SOUL excerpt as needed.
Unused optional tool fields may be omitted or null. Shared memory, routines,
channels, and scheduled skills are deliberately out of scope. Never store secrets
in bot state.

## Bots navigation rail

Bots Fleet registers BB's **Bots** navigation-rail panel: the familiar sidebar
tree on the left and conversation content on the right. The rail icon can show a
badge for **bot-assigned** conversations only (explicit bindings and child
threads that inherit a bound ancestor—not unassigned threads): a warning count
when those conversations wait for your input, or a critical dot when unread
assigned conversations have errors (no count).

- The panel home offers **Create bot** when no conversation is selected.
- Click a sidebar row to open that conversation **in the panel** with full
  `ThreadChat` (permissions inherit from the conversation).
- **Open in BB** in the panel header opens the same conversation in BB's main
  workspace. Hold **Cmd** (macOS) or **Ctrl** (other platforms) when clicking a
  sidebar row or **Open in BB** to open it in a split main-workspace view
  instead.

## Sidebar interactions

Within the Bots nav rail, the sidebar tree behaves as follows:

- Click a bot to open the **first conversation in its list**, without expanding
  or collapsing it. The end chevron independently toggles the full list and
  counts top-level conversations. There is no special main conversation.
  Double-click the bot name/avatar to fold or unfold the list as well.
  The subtitle keeps the bot's role, followed by its owned project names—not
  the first conversation's title. Long labels truncate with full hover text.
- Drag above or below a sibling to reorder conversations; **Move to top** in
  the context menu is the keyboard/touch alternative. Shift-drop nests a thread.
  Order is stored privately and shared across clients. Unordered conversations
  appear newest-created first after manually placed ones; activity never reshuffles
  them. Archiving the first conversation makes the next one the click target.
- Hover a bot row to reveal **+** (also available on keyboard focus and touch).
  It opens the native composer without opening a conversation or expanding the bot.
  **+** and **New conversation…** default to an owned project on the bot's configured
  machine. With multiple owned projects, prefer the first conversation's project if owned, then
  the first owned project in link order. Mere membership does not change the
  personal-workspace default. The project and machine remain editable.
- Assign an unassigned conversation with the experimental **Assign to bot** thread
  action (BB thread menu). Any bot can be chosen; it joins the conversation's work
  project as a member if needed. Projectless chats need no project link. History,
  project, environment, and existing child assignments stay unchanged. A success
  toast offers **View** to open the conversation in the Bots panel.
  Drop an existing top-level conversation on its own bot row to move it to the top.
- Hover a conversation row to reveal its archive button, also available on
  keyboard focus and touch. It sits inline before the child count, never covering
  the title or disclosure. This uses BB's normal archive action, including children.
- Each conversation's right-edge count/chevron reveals only its own children,
  collapsed by default. Once a bot is explicitly expanded, navigation reveals
  the viewed ancestor path. Navigation never expands a collapsed bot.
- The avatar's bottom-right spinner shows its **first conversation** working. Small pulsing dots
  to the left show other working conversations—even when collapsed. Three slots
  keep it compact; a **+** indicates overflow and the tooltip gives the exact count.
  Other work never makes an idle first conversation look busy. Waiting/errors remain distinct.
- Working conversation rows spin; completed ones are green dots while unviewed,
  then smaller gray dots. Reduced motion disables all activity animations.
- **Main** is the invisible default section. Explicit custom sections retain their
  headings. Drag bots to reorder/move; the Section picker includes **Create New…**.
- Create/Edit stays compact: small avatar with a dice button, name/role, Bot /
  Context / Projects tabs, one file editor, and an always-visible footer.
  New bots get a random appearance once per draft; existing bots stay unchanged.
  Appearance offers **8 shapes, 16 expressions, 3 idle motions, and 14 coloured
  presets**, with no black/white/neutral presets. **Randomize appearance** rerolls
  explicitly. Existing/custom hex colours remain supported.
- Sidebar faces occasionally show a brief idle expression (3–5 seconds, spaced
  5–12 minutes apart). After 30 minutes without activity they look bored; after
  two hours, sleepy. Work, pending input, and unread errors restore the chosen face.
  These are display-only changes: saved appearance and editor previews stay intact.
  Random bursts pause in hidden windows and are disabled by Still/reduced motion.
  Machine is an execution default, never the state storage location.
- All **New conversation** actions open the same native composer popup immediately,
  without a separate project-selection step. **+** / **New conversation…** use
  ownership-aware defaults; **in project** selects a checkout; **in worktree**
  selects a fresh worktree. For explicit project/worktree actions, the current
  work context or a linked project is preselected, and you can change
  the project, machine, and harness inside the popup before sending.
- **New conversation in worktree…** selects a fresh managed worktree on the
  originating conversation's machine (or the bot's first-conversation/default machine), never
  reuses the existing worktree. The picker remains editable; if that machine lacks
  a project source, BB may fall back to an available source.
- Save is explicit; Enter never submits text fields. Drafts survive tab changes.
  Discard unsaved bot state/context edits uses a plugin confirmation dialog. No sidebar
  overlay toolbars, activity dates, or Chats pane; the hidden-bot toggle stays at the
  bottom. Several bots may share a project without sharing identity or conversation
  ownership.

## Plugin identity

The runtime ID is **`bots-fleet`**, derived from package **`bb-plugin-bots-fleet`**.
Settings shows **Bots Fleet**. Reload with `bb plugin reload bots-fleet`. The
community plugin named `bots` is unrelated; Bots Fleet never reads its storage.

Bots Fleet replaces **Bots Sidebar** (`bots-sidebar`) on a machine; the two do not
run together. Installing Bots Fleet starts with empty plugin storage until you import
the old data once:

1. `bb plugin disable bots-sidebar`
2. `bb plugin install path:/path/to/bb-bots-fleet --yes` (or your package source)
3. `bb bots migrate-from bots-sidebar`
4. After verifying bots, conversations, and private exports, `bb plugin remove bots-sidebar`

`bb bots migrate-from bots-sidebar` copies `data.db` and the `state/` exports from
`<data-dir>/plugins/bots-sidebar/` into Bots Fleet after confirming Bots Sidebar is
disabled and has no pending conversation-start tokens. It records the migration in
`bot_state` and is one-time only. Until that command succeeds, Bots Fleet shows a
warning on refresh, `bb bots list` prints the same hint on stderr, new bot creation
is blocked, and version-1 project import stays deferred even if you open the sidebar
before step 3. An unreadable sidebar `data.db` is logged and treated like pending
migration data (not an empty install). After the database commit, staged bot
exports copy through `state-migration-pending-*` under the fleet plugin data
directory into `state/`; if that final copy fails, exports remain in the pending
directory and the error names that path for recovery. If staging cannot be copied
into plugin data at all, the error names the temporary staging directory instead.
Bot IDs, main pointers, thread bindings, and
historical `originPluginId` values (including `bots-sidebar` and the earlier private
`bots` namespace) stay unchanged; routing still resolves through saved bindings.
Keep a backup of both plugin directories before switching. Client layout and
compose-draft keys intentionally remain stable. If Settings → Sidebar explicitly
pinned Bots Sidebar, select **Bots Fleet**; Automatic needs no change.

## Migration and cleanup

Existing IDs, sections, avatars, linked projects, main pointers, and conversation
bindings are preserved. Version-2 home state is imported once after verifying its
ownership marker. Missing/offline/corrupt sources fall back to that bot's own cached
state with a warning; later source changes never overwrite newer private state.
Version-1 project-backed records are still imported from a one-time snapshot,
including reconciled live/archived history, but only after any pending Bots Sidebar
handoff in § Plugin identity completes. Ordinary/new projects never become bots
automatically.

Migration never deletes or modifies legacy source files, project folders, or
conversations. Old home projects are retained for existing history but are not
used for new bot launches. Start an ordinary new conversation and reorder the
list to choose what opens when clicking the bot; old history remains accessible.

Cleanup of old generated project `SOUL.md` / `bot.json` files is a separate,
owner-approved operation: compare against saved migration hashes, keep tracked or
independently changed files, and move eligible files into private backups. Never
remove a project's `AGENTS.md`. Keep a consistent plugin database backup before
switching storage versions; the prior code checkpoint is
`checkpoint/home-project-bots`.

## Develop

Use BB 0.46.1 or newer, Node.js per `.node-version`, and pnpm via Corepack
(`packageManager` in `package.json`). No BB-core change is required for this model.

```sh
git clone --branch main https://github.com/Limitless-Enterprise/bb-bots-fleet.git
cd bb-bots-fleet
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
bb plugin build
bb plugin install . --yes
```

The source began with BB's standard scaffold, not another sidebar plugin. Avatar
appearance options are adapted from [bloub](https://github.com/jeremy-prt/bloub).
See [third-party notices](THIRD_PARTY_NOTICES.md) for its MIT attribution.
Dependencies are installed independently; no other BB plugin is required.

### Bot coordination

Type **@** followed by a bot name, role, or ID in a composer. Results appear under
**Bots**; **@bots** lists the available bots, including ones hidden from the sidebar.
Mentions use stable bot IDs, so duplicate names and later renames do not redirect
an existing reference. Selecting a bot inserts a mention—not a message or an
assignment. At send time it supplies only public name/role/ID and messaging guidance,
never that bot's private SOUL, memory, or settings.

Bot context states the current project relationship: owner, joined member (with the owner's name and ID), or not joined. Personal chats have no work-project role. `bot_read_state({"target":"project"})` refreshes this relationship alongside linked and available projects. Ownership routes new project conversations; it does not grant authority over other agents or the user.

```sh
bb bots list
bb bots list --json --limit 50 --offset 0
bb bots show <bot-id-or-address> [--json]
bb bots memory <bot-id-or-exact-name> list [--json]
bb bots memory <bot> read <entry-id> [--json]
bb bots memory <bot> edit <entry-id> --from <file>
bb bots memory <bot> export --to <directory>
bb bots message <bot> "Please review the changes"
bb bots message billing/lead "Scoped to one node"
bb bots message <bot-id> "My reply" --thread <sender-conversation-id>
```

`bb bots memory` resolves its bot selector by **BOT ID** or exact name only (not
fleet path addresses such as `billing/lead`). It refuses calls that carry a BB thread context (the CLI derives
`ctx.threadId` from the caller's environment). On a single machine and OS user
this is policy-enforced, not isolation: a shell can run
`env -u BB_THREAD_ID bb bots memory …` and read any bot's level-1 memory. Full
isolation requires bot conversations on execution machines separate from the BB
server (ADR 0010 §7; foundation §6.7). `bb bots show` prints level-1 memory
entry and byte counts for one bot (same counts embedded in `bb bots list --json`
per bot).

`bb bots message` resolves `<bot>` as a stable bot ID, a fleet address such as
`billing/lead` or `billing/ledger/worker`, a unique shared bot name with no
node, or a unique node-local name when only one bot in the fleet uses that
name. Duplicate names require a full address or ID; errors list matching
addresses. Messages use BB's native queue: idle conversations start a turn, busy
conversations receive the message later. The default destination is the
recipient's first visible ordered conversation; `--thread` must belong to that
bot. Messages identify the invoking conversation and its bound bot, clearly
distinguish agent coordination from user instructions, and include an
asynchronous reply command. FYI messages need no acknowledgement. Unbound
conversations and external CLI callers are labeled accurately. `bb bots message`
does not create conversations or change membership, bindings, permissions, or
private state.

Listing exposes public bot metadata only and paginates at 100 bots maximum.
`bb bots list --json` also includes per-bot `memory: { entries, bytes }` (live
entry count and total body bytes, never entry titles or bodies). Quote messages
(maximum 12,000 characters). Delivery receipts confirm acceptance, not task
completion or a reply.

`bb bots list` shows **BOT ID**, **ADDRESS**, **PARENT**, **NAME**, **STATUS**,
**VISIBILITY**, **OWNED PROJECTS**, **JOINED PROJECTS**, **ROLE**, and **FIRST
CONVERSATION**. JSON includes the same fields (`address`, `nodePath`,
`parentBotId`, `parentName`, project IDs and names). Either the bot ID or
**ADDRESS** column works as a `bb bots message` target. Activity aggregates all
non-archived bot conversations,
including inherited children and hidden conversations: waiting takes precedence over
working, then error, then idle. Visibility separately reflects the bot's hidden setting.

Fleet registry commands (see the [Bots CLI LLD](https://github.com/Limitless-Enterprise/srs/blob/docs/agent-fleet-design/agent-fleet/03-architecture/low-level-design-bots-cli.md)
for full flags) manage app/schema nodes and bot records in plugin storage:

```sh
bb bots node create billing --kind app --project <project>
bb bots node create billing/ledger --kind schema --data-service-path api/ledger
bb bots node list [app] [--json]
bb bots create --name lead --role "Module Lead" --machine <host> --soul "..." --node billing
bb bots create --name ui --role Engineer --machine <host> --soul "..." --node billing --parent billing/lead
bb bots update billing/lead --role "Updated role"
bb bots show billing/ui [--json]
bb bots tree [app] [--json]
bb bots link <bot> <project> --as owner|member
bb bots unlink <bot> <project>
bb bots release <bot> <project>
```

Create app and schema nodes before attaching bots with `--node`. Bot create and
update route through the same registry validation and private-state mirroring
as the sidebar; link, unlink, and release adjust project membership and
ownership atomically.

Fleet registry commands (`node create`, `create`, `update`, `link`, `unlink`,
`release`, and later `main` / `deploy`) refuse calls that carry a BB thread
context (`ctx.threadId`), except when the invoking conversation resolves through
`resolveOwner` to the shared `fleet` steward bot. `show`, `tree`, and `list`
stay readable from any conversation. On a single machine and OS user this is
policy-enforced, not isolation: an operator shell can still run the same
commands without a thread context.

Incoming bot messages use BB's native attributed, expandable agent-message row
and sender-conversation link. Inside it, a **🤖 Bot message · Name** heading and
the original message come first; delivery context and the exact reply command follow
under a separator. This keeps the content easy to scan while preserving the agent's
attribution and asynchronous handling instructions. No custom timeline renderer is used.
