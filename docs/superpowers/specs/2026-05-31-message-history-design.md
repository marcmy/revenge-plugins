# Message History Plugin Design

## Risk

Implementation risk is XHIGH. The plugin patches Discord mobile message dispatch, message rendering, action-sheet UI, plugin storage, and cleanup behavior. User approval to proceed was given after the risk callout.

## Goal

Create a new Revenge plugin that keeps deleted and edited message history without writing history back into message content. The plugin should replace the annoying Antied Zero behavior where edit history becomes visible to everyone when the user edits a message again.

## Source Context

The repo currently contains two plugins under `plugins/` and a Rollup build script that reads each plugin manifest and bundles `manifest.main` into `dist/<plugin>/index.js`.

Antied Zero source lives in `Angelix1/MP/angel/antiedzero`. It patches `FluxDispatcher.dispatch` for `MESSAGE_UPDATE` and `MESSAGE_DELETE`, patches message long-press action sheets, and uses Vendetta APIs. Its edit-history implementation prepends old content to `message.content`, which is the behavior this design avoids.

Vencord's desktop MessageLogger keeps edit history as separate metadata and shows it from a UI opened through the edited marker. Revenge mobile does not expose the same stable desktop patch points, so the first implementation should use a long-press action sheet entry. A direct edited-marker press target can be investigated after the safe path works.

## UX

The plugin adds long-press actions on messages:

- `View Edit History` appears when a message has one or more logged edits.
- `Clear Message History` appears when a message has edit or delete history.

The history UI opens in a native custom alert/modal and shows the newest version plus previous versions with timestamps. Deleted messages are preserved in place and visually marked as deleted without changing the logged content.

Settings include:

- Log edits
- Log deletes
- Persist history
- Max total records, default 200
- Max records per channel, default 50
- Max edits per message, default 10
- Max age in days, default 3
- Clear all history

## Data Model

History is stored as records keyed by channel and message:

```ts
type HistoryKind = "edit" | "delete";

interface HistoryRecord {
  id: string;
  kind: HistoryKind;
  channelId: string;
  guildId?: string | null;
  messageId: string;
  authorId?: string | null;
  authorUsername?: string | null;
  content: string;
  attachments: any[];
  embeds: any[];
  timestamp: number;
}
```

Records live in memory and, when persistence is enabled, in plugin `storage.historyRecords`. Storage is easier and safer than a separate file in this repo because the existing plugins already use `@vendetta/plugin` storage and the installed types expose that API.

## Architecture

Create a new plugin at `plugins/MessageHistory`.

Files:

- `manifest.json`: Revenge/Vendetta plugin metadata.
- `src/types.ts`: shared record and settings types.
- `src/history.ts`: pure helper functions for defaults, record insertion, pruning, lookup, and clearing.
- `src/ui.tsx`: history modal and action-sheet helpers.
- `src/settings.tsx`: settings page.
- `src/index.ts`: plugin lifecycle and Discord patch registration.

`src/index.ts` owns all unstable mobile patching. It keeps a small cache of seen messages, patches `FluxDispatcher.dispatch`, captures old content before updates, captures messages before deletes, and registers action-sheet rows that call `src/ui.tsx`.

`src/history.ts` remains pure so retention behavior can be tested outside the mobile runtime.

## Retention

The default retention rule combines all requested limits:

1. Drop records older than 3 days.
2. Keep at most 10 records per message.
3. Keep at most 50 records per channel.
4. Keep at most 200 records total.

Purging runs on plugin load and after every new record. Lower limits are clamped to safe minimums in code so broken settings cannot create unbounded growth.

## Error Handling

All patches use local `try/catch` guards. If a patch fails, the plugin logs a namespaced console error and shows a short toast only for user-visible failures. Patch registration stores unpatch callbacks and unload drains them defensively.

The plugin ignores bot ephemeral messages and empty messages, following Antied Zero's safety checks.

## Verification

Verification should include:

- Compile and run isolated retention checks by bundling `src/history.ts` with esbuild and asserting purge behavior from Node.
- Run `npm run build`.
- Inspect generated `dist/MessageHistory/manifest.json` and `dist/MessageHistory/index.js`.
- Manual mobile checks after install:
  - Editing a message does not prepend history into the real message content.
  - Editing the same message multiple times does not leak history into the outgoing edit.
  - Long-press `View Edit History` shows prior versions.
  - Deleting a message preserves a marked deleted copy when delete logging is enabled.
  - Disabling persistence and reloading clears history.
  - Enabling persistence and reloading retains history until retention limits purge it.

