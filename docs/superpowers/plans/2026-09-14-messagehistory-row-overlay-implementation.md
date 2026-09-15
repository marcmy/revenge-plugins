# MessageHistory Row-Overlay Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MessageHistory's synthetic deleted-message reinjection with a render-only row overlay that preserves deleted messages across restarts, places them correctly, dismisses them cheaply and permanently from inline chat, and leaves Discord's canonical message state untouched.

**Architecture:** Keep persisted MessageHistory records as the source of truth. Capture real delete/update events without mutating them, maintain a bounded recent-message cache only for recovering pre-change state, and overlay eligible saved-delete tombstones into Discord's native `createChannelStream` output according to the currently loaded real-message window. Inline dismissal updates only plugin-owned presentation state and triggers a coalesced local refresh.

**Tech Stack:** TypeScript/TSX, Revenge/Vendetta Metro module discovery, Vendetta patcher, Discord mobile native DCDChat/createChannelStream internals, Node/esbuild regression harness, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-14-messagehistory-row-overlay-design.md`

## Global Constraints

- Real Discord `MESSAGE_DELETE` and `MESSAGE_UPDATE` events must never be rewritten or replaced.
- Saved deleted rows must never be committed to `MessageStore`, `ChannelMessages`, or emitted through Flux.
- Persisted history is MessageHistory's source of truth.
- Inline dismissal hides a deleted row from chat but retains its saved history record.
- Saved deletes render only when their original ordering key belongs to the currently loaded real-message window, with open-ended eligibility only when Discord reports there is no more history on that edge.
- One inline tombstone maximum per `channelId + messageId`, including legacy duplicate records.
- Tombstones must not use Discord's EPHEMERAL flag.
- Runtime message caching must be bounded to 750 recent snapshots and cleared on unload.
- Edit capture must merge partial `MESSAGE_UPDATE` payloads before deciding whether content changed.
- Render invalidation must not use fake message events; repeated rapid state changes should be coalesced.
- If the overlay patch cannot be discovered or one tombstone cannot be converted, history capture/browser behavior must continue without synthetic fallback.
- The overlay must compose with LongScreenshotFix by calling the next/original `createChannelStream` function and transforming only its returned rows.

---

## File Structure

- `plugins/MessageHistory/src/history.ts` — pure persisted-record normalization, retention, visibility, dismissal, deduplication, and ordering helpers.
- `plugins/MessageHistory/src/types.ts` — persisted record and snapshot types, including `inlineHidden`.
- `plugins/MessageHistory/src/capture.ts` — bounded recent-message cache, immutable snapshot creation, partial-update merge, and edit/delete capture helpers.
- `plugins/MessageHistory/src/overlay.ts` — pure loaded-window calculation, delete eligibility/deduplication, tombstone construction, row merging, and refresh coalescing helpers.
- `plugins/MessageHistory/src/index.ts` — Metro discovery, patch registration, event observation, action-sheet wiring, overlay installation, lifecycle only.
- `plugins/MessageHistory/src/ui.tsx` — history modal and reusable action-sheet row rendering.
- `plugins/MessageHistory/src/settings.tsx` — settings/history browser; remove reinjection-debug controls and make clear-history cooperate with plugin-local state.
- `plugins/MessageHistory/src/debug.tsx` — delete after the old reinjection architecture is removed.
- `scripts/check-message-history-retention.mjs` — extend pure history tests to migration/dismissal semantics.
- `scripts/check-message-history-capture.mjs` — new deterministic cache/partial-update regression harness.
- `scripts/check-message-history-overlay.mjs` — new deterministic placement/pagination/dismissal regression harness.
- `.github/workflows/ci.yml` — compile MessageHistory pure modules and run all MessageHistory regression harnesses before the normal plugin build.

---

### Task 1: Persisted delete visibility model and migration

**Files:**
- Modify: `plugins/MessageHistory/src/types.ts`
- Modify: `plugins/MessageHistory/src/history.ts`
- Modify: `scripts/check-message-history-retention.mjs`

**Interfaces:**
- Produces: `HistoryRecord.inlineHidden?: boolean`
- Produces: `normalizeHistoryRecord(record: HistoryRecord): HistoryRecord`
- Produces: `getInlineDeleteRecords(state: HistoryState, channelId: string): HistoryRecord[]`
- Produces: `setDeleteInlineHidden(state: HistoryState, channelId: string, messageId: string, hidden: boolean): HistoryState`
- Produces: `dedupeDeleteRecordsByMessage(records: HistoryRecord[]): HistoryRecord[]`
- Existing `pruneRecords`, `getMessageRecords`, `getKindRecords`, `getRecordMessageTimestamp` remain stable.

- [ ] **Step 1: Write failing migration/dismissal tests**

Extend `scripts/check-message-history-retention.mjs` with concrete assertions:

```js
const legacyDelete = { ...deleteRecords[0] };
delete legacyDelete.inlineHidden;
const normalizedLegacy = normalizeHistoryRecord(legacyDelete);
if (normalizedLegacy.inlineHidden !== false) {
  throw new Error("Expected legacy delete records to migrate inlineHidden=false");
}

const hiddenState = setDeleteInlineHidden(
  { records: [normalizedLegacy] },
  normalizedLegacy.channelId,
  normalizedLegacy.messageId,
  true,
);
if (getInlineDeleteRecords(hiddenState, normalizedLegacy.channelId).length !== 0) {
  throw new Error("Expected inline-hidden deletes to stay out of overlay candidates");
}
if (getKindRecords(hiddenState, "delete").length !== 1) {
  throw new Error("Expected inline-hidden deletes to remain saved in history");
}

const duplicateDelete = {
  ...normalizedLegacy,
  id: `${normalizedLegacy.id}:duplicate`,
  timestamp: normalizedLegacy.timestamp + 1,
};
const deduped = dedupeDeleteRecordsByMessage([normalizedLegacy, duplicateDelete]);
if (deduped.length !== 1 || deduped[0].id !== duplicateDelete.id) {
  throw new Error("Expected newest delete record to win legacy duplicate dedupe");
}
```

Import the new helpers explicitly at the top of the script.

- [ ] **Step 2: Run the retention harness and confirm RED**

Compile and run:

```bash
npx esbuild plugins/MessageHistory/src/history.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/history.mjs
npx esbuild plugins/MessageHistory/src/settingsOptions.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/settingsOptions.mjs
node scripts/check-message-history-retention.mjs
```

Expected: FAIL because the new exported helpers/field behavior do not exist yet.

- [ ] **Step 3: Implement persisted visibility/migration helpers**

In `types.ts`, extend `HistoryRecord`:

```ts
inlineHidden?: boolean;
```

In `history.ts`, normalize records before pruning:

```ts
export function normalizeHistoryRecord(record: HistoryRecord): HistoryRecord {
    return {
        ...record,
        inlineHidden: record.kind === "delete" ? record.inlineHidden === true : false,
    };
}
```

Update `pruneRecords()` to map `normalizeHistoryRecord` before sorting/filtering.

Add deterministic delete dedupe and visibility helpers:

```ts
export function dedupeDeleteRecordsByMessage(records: HistoryRecord[]): HistoryRecord[] {
    const newest = new Map<string, HistoryRecord>();
    for (const record of sortNewestFirst(records.filter((record) => record.kind === "delete"))) {
        const key = messageKey(record.channelId, record.messageId);
        if (!newest.has(key)) newest.set(key, normalizeHistoryRecord(record));
    }
    return [...newest.values()];
}

export function getInlineDeleteRecords(state: HistoryState, channelId: string): HistoryRecord[] {
    return sortOldestByMessageTime(
        dedupeDeleteRecordsByMessage(state.records ?? []).filter(
            (record) => record.channelId === channelId && record.inlineHidden !== true,
        ),
    );
}

export function setDeleteInlineHidden(
    state: HistoryState,
    channelId: string,
    messageId: string,
    hidden: boolean,
): HistoryState {
    return {
        records: (state.records ?? []).map((record) =>
            record.kind === "delete" && record.channelId === channelId && record.messageId === messageId
                ? { ...record, inlineHidden: hidden }
                : record,
        ),
    };
}
```

Remove `createSyntheticDeletedMessage`, `createSyntheticDeletedCreateEvent`, `isSyntheticDeletedMessage`, and `shouldConsumeSyntheticDeletedDismiss` only after all production references are removed in Task 4; until then leave them temporarily to keep the branch buildable.

- [ ] **Step 4: Run retention harness and confirm GREEN**

Run the same three commands from Step 2.

Expected: `message history retention ok`.

- [ ] **Step 5: Commit**

```bash
git add plugins/MessageHistory/src/types.ts plugins/MessageHistory/src/history.ts scripts/check-message-history-retention.mjs
git commit -m "refactor: add inline delete visibility state"
```

---

### Task 2: Bounded capture cache and partial update merging

**Files:**
- Create: `plugins/MessageHistory/src/capture.ts`
- Create: `scripts/check-message-history-capture.mjs`
- Modify: `plugins/MessageHistory/src/index.ts` later in Task 4 only; Task 2 exports the interfaces first.

**Interfaces:**
- Produces: `const MESSAGE_CACHE_LIMIT = 750`
- Produces: `class RecentMessageCache`
- Produces: `snapshotMessage(message: any, fallbackChannelId?: string): MessageSnapshot | null`
- Produces: `mergeMessageUpdate(previous: any, patch: any, fallbackChannelId?: string): any`
- Produces: `contentChanged(previous: MessageSnapshot | null, next: MessageSnapshot | null): boolean`
- Produces: `messageKey(channelId: string, messageId: string): string`

- [ ] **Step 1: Write failing capture regression harness**

Create `scripts/check-message-history-capture.mjs` covering partial updates and eviction:

```js
import {
  MESSAGE_CACHE_LIMIT,
  RecentMessageCache,
  contentChanged,
  mergeMessageUpdate,
  snapshotMessage,
} from "../.codex-tmp/MessageHistory/capture.mjs";

const original = {
  id: "100",
  channel_id: "10",
  content: "hello",
  attachments: [{ id: "a" }],
  embeds: [{ type: "rich" }],
  author: { id: "1", username: "marc" },
  timestamp: "2026-09-14T20:00:00.000Z",
};

const metadataOnly = mergeMessageUpdate(original, {
  id: "100",
  channel_id: "10",
  embeds: [{ type: "rich", title: "hydrated" }],
});
if (metadataOnly.content !== "hello" || metadataOnly.attachments.length !== 1) {
  throw new Error("Expected partial updates to preserve omitted message fields");
}
if (contentChanged(snapshotMessage(original), snapshotMessage(metadataOnly))) {
  throw new Error("Expected metadata-only update not to count as an edit");
}

const edited = mergeMessageUpdate(original, {
  id: "100",
  channel_id: "10",
  content: "hello edited",
  edited_timestamp: "2026-09-14T20:01:00.000Z",
});
if (!contentChanged(snapshotMessage(original), snapshotMessage(edited))) {
  throw new Error("Expected a real content edit to be detected");
}

const cache = new RecentMessageCache(MESSAGE_CACHE_LIMIT);
for (let i = 0; i < MESSAGE_CACHE_LIMIT + 20; i++) {
  cache.set({ ...original, id: String(1000 + i) });
}
if (cache.size !== MESSAGE_CACHE_LIMIT) {
  throw new Error(`Expected bounded cache size ${MESSAGE_CACHE_LIMIT}, got ${cache.size}`);
}
if (cache.get("10", "1000")) {
  throw new Error("Expected oldest cache entry to be evicted");
}

console.log("message history capture ok");
```

- [ ] **Step 2: Compile/run and confirm RED**

```bash
npx esbuild plugins/MessageHistory/src/capture.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/capture.mjs
node scripts/check-message-history-capture.mjs
```

Expected: FAIL because `capture.ts` does not exist.

- [ ] **Step 3: Implement capture module**

Create `capture.ts` with:

```ts
import type { MessageSnapshot } from "./types";
import { hasVisibleContent } from "./history";

export const MESSAGE_CACHE_LIMIT = 750;

export function messageKey(channelId: string, messageId: string) {
    return `${channelId}:${messageId}`;
}

export function snapshotMessage(message: any, fallbackChannelId?: string): MessageSnapshot | null {
    const id = message?.id;
    const channelId = message?.channel_id ?? message?.channelId ?? fallbackChannelId;
    if (!id || !channelId || message?.author?.bot) return null;

    const snapshot: MessageSnapshot = {
        id,
        channelId,
        guildId: message?.guild_id ?? message?.guildId ?? null,
        authorId: message?.author?.id ?? message?.authorId ?? null,
        authorUsername: message?.author?.username ?? message?.author?.globalName ?? null,
        content: message?.content ?? "",
        attachments: Array.isArray(message?.attachments) ? [...message.attachments] : [],
        embeds: Array.isArray(message?.embeds) ? [...message.embeds] : [],
        timestamp: message?.timestamp ?? message?.edited_timestamp ?? null,
        raw: message,
    };

    return hasVisibleContent(snapshot) ? snapshot : null;
}

export function mergeMessageUpdate(previous: any, patch: any, fallbackChannelId?: string) {
    if (!previous) return patch;
    const channelId = patch?.channel_id ?? patch?.channelId ?? previous?.channel_id ?? previous?.channelId ?? fallbackChannelId;
    return {
        ...previous,
        ...patch,
        channel_id: channelId,
        attachments: patch?.attachments ?? previous?.attachments ?? [],
        embeds: patch?.embeds ?? previous?.embeds ?? [],
        author: patch?.author ?? previous?.author,
        content: Object.prototype.hasOwnProperty.call(patch ?? {}, "content") ? patch.content : previous?.content,
    };
}

export function contentChanged(previous: MessageSnapshot | null, next: MessageSnapshot | null) {
    return Boolean(previous && next && previous.content !== next.content);
}

export class RecentMessageCache {
    private readonly entries = new Map<string, MessageSnapshot>();

    constructor(private readonly limit = MESSAGE_CACHE_LIMIT) {}

    get size() {
        return this.entries.size;
    }

    get(channelId: string, messageId: string) {
        return this.entries.get(messageKey(channelId, messageId));
    }

    set(message: any, fallbackChannelId?: string) {
        const snapshot = snapshotMessage(message, fallbackChannelId);
        if (!snapshot) return null;
        const key = messageKey(snapshot.channelId, snapshot.id);
        this.entries.delete(key);
        this.entries.set(key, snapshot);
        while (this.entries.size > this.limit) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
        return snapshot;
    }

    delete(channelId: string, messageId: string) {
        this.entries.delete(messageKey(channelId, messageId));
    }

    clear() {
        this.entries.clear();
    }
}
```

Keep `raw` temporarily because delete capture may need original renderer fields; do not place synthetic tombstones in this cache.

- [ ] **Step 4: Run capture harness and confirm GREEN**

Run the two commands from Step 2.

Expected: `message history capture ok`.

- [ ] **Step 5: Commit**

```bash
git add plugins/MessageHistory/src/capture.ts scripts/check-message-history-capture.mjs
git commit -m "refactor: bound MessageHistory capture state"
```

---

### Task 3: Pure row-overlay placement engine

**Files:**
- Create: `plugins/MessageHistory/src/overlay.ts`
- Create: `scripts/check-message-history-overlay.mjs`

**Interfaces:**
- Consumes: `HistoryRecord`, `getInlineDeleteRecords`, `getRecordMessageTimestamp`
- Produces: `getRowMessage(row: any): any | null`
- Produces: `getLoadedMessageWindow(rows: any[], hasMoreBefore: boolean, hasMoreAfter: boolean): LoadedMessageWindow | null`
- Produces: `selectOverlayDeleteRecords(records: HistoryRecord[], window: LoadedMessageWindow): HistoryRecord[]`
- Produces: `mergeDeletedRows(rows: any[], records: HistoryRecord[], makeRow: (record) => any, options): any[]`
- Produces: `createRenderRefreshScheduler(callback: () => void, delayMs?: number): { request(): void; dispose(): void }`

- [ ] **Step 1: Write failing overlay harness**

Create a harness with real-row stubs and three pagination windows. The critical assertions are:

```js
const real = (id, timestamp) => ({
  rowType: 1,
  message: { id, channel_id: "c", timestamp },
});
const tombstone = (record) => ({
  rowType: 1,
  message: {
    id: record.messageId,
    channel_id: record.channelId,
    timestamp: new Date(record.messageTimestamp).toISOString(),
    message_history_overlay_deleted: true,
  },
});

const newestRows = [
  real("300", "2026-09-14T20:30:00.000Z"),
  real("400", "2026-09-14T20:40:00.000Z"),
];
const records = [
  deleteRecord("150", "2026-09-14T20:15:00.000Z"),
  deleteRecord("350", "2026-09-14T20:35:00.000Z"),
  deleteRecord("450", "2026-09-14T20:45:00.000Z"),
];

const newest = mergeDeletedRows(newestRows, records, tombstone, {
  hasMoreBefore: true,
  hasMoreAfter: false,
});
assertIds(newest, ["300", "350", "400", "450"]);

const extendedRows = [
  real("100", "2026-09-14T20:10:00.000Z"),
  real("200", "2026-09-14T20:20:00.000Z"),
  ...newestRows,
];
const extended = mergeDeletedRows(extendedRows, records, tombstone, {
  hasMoreBefore: false,
  hasMoreAfter: false,
});
assertIds(extended, ["100", "150", "200", "300", "350", "400", "450"]);

const duplicateRecords = [records[1], { ...records[1], id: "dup", timestamp: records[1].timestamp + 1 }];
const deduped = mergeDeletedRows(newestRows, duplicateRecords, tombstone, {
  hasMoreBefore: true,
  hasMoreAfter: false,
});
if (extractIds(deduped).filter((id) => id === "350").length !== 1) {
  throw new Error("Expected one tombstone per message id");
}
```

Also test:
- a hidden record is excluded;
- a record newer than newest real message is excluded when `hasMoreAfter=true` and included when `hasMoreAfter=false`;
- a record older than oldest real message is excluded when `hasMoreBefore=true` and included when `hasMoreBefore=false`;
- repeated `mergeDeletedRows()` calls do not mutate the input rows;
- refresh scheduler coalesces five rapid `request()` calls into one callback.

- [ ] **Step 2: Compile/run and confirm RED**

```bash
npx esbuild plugins/MessageHistory/src/overlay.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/overlay.mjs
node scripts/check-message-history-overlay.mjs
```

Expected: FAIL because `overlay.ts` does not exist.

- [ ] **Step 3: Implement pure loaded-window and merge logic**

Define:

```ts
export interface LoadedMessageWindow {
    oldestKey: [number, string] | null;
    newestKey: [number, string] | null;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
}
```

Use original timestamp plus message ID as ordering key. `getRowMessage()` should accept common native row shapes (`row.message`, `row.messageRecord`, nested `row.content?.message`) while rejecting MessageHistory overlay rows when calculating real bounds.

Eligibility rule:

```ts
const afterOldest = window.oldestKey === null || compareKey(recordKey, window.oldestKey) >= 0 || !window.hasMoreBefore;
const beforeNewest = window.newestKey === null || compareKey(recordKey, window.newestKey) <= 0 || !window.hasMoreAfter;
return afterOldest && beforeNewest;
```

Before merging, dedupe records by `channelId + messageId` and exclude `inlineHidden === true`.

Do not globally sort all row descriptors because non-message rows (`LOAD_BEFORE`, dividers, system rows) have positional meaning. Instead insert each tombstone adjacent to the real message gap determined by message ordering while preserving non-message row relative order. For the two open edges, insert just inside the corresponding message region rather than ahead of `LOAD_BEFORE` or after `LOAD_AFTER` sentinels.

- [ ] **Step 4: Run overlay harness and confirm GREEN**

Run the two commands from Step 2.

Expected: `message history overlay ok`.

- [ ] **Step 5: Commit**

```bash
git add plugins/MessageHistory/src/overlay.ts scripts/check-message-history-overlay.mjs
git commit -m "feat: add MessageHistory row overlay engine"
```

---

### Task 4: Wire non-mutating capture and native row overlay

**Files:**
- Modify: `plugins/MessageHistory/src/index.ts`
- Modify: `plugins/MessageHistory/src/history.ts`
- Modify: `plugins/MessageHistory/src/ui.tsx` if reusable tombstone actions need a helper.

**Interfaces:**
- Consumes Task 1 history helpers, Task 2 `RecentMessageCache`/merge helpers, Task 3 overlay helpers.
- Produces plugin lifecycle with no synthetic Flux reinjection.
- Produces plugin-local tombstone marker `message_history_overlay_deleted: true` on transient renderer objects only.

- [ ] **Step 1: Add source-level regression assertions before production edits**

Extend `scripts/check-message-history-overlay.mjs` to read `plugins/MessageHistory/src/index.ts` and fail if the redesigned production file still contains any forbidden reinjection token after Task 4:

```js
const forbidden = [
  "createSyntheticDeletedCreateEvent",
  "injectedDeletedMessages",
  "recentlyPreservedDeletes",
  "consumeSyntheticDeletedDismiss",
  'event.type = "MESSAGE_UPDATE"',
  "event.messages = sortMessagesLikeBatch",
];
for (const token of forbidden) {
  if (indexSource.includes(token)) throw new Error(`Forbidden legacy reinjection path remains: ${token}`);
}
```

Also assert the file contains `findByName("createChannelStream"` and `RecentMessageCache`.

- [ ] **Step 2: Run harness and confirm RED**

Expected: FAIL on at least one forbidden legacy reinjection token.

- [ ] **Step 3: Replace runtime capture path**

In `index.ts`:

- instantiate `const messageCache = new RecentMessageCache();`
- retain patches around available dispatcher methods, but make `handleDispatchEvent()` observational only;
- on ordinary message/load events, feed real messages into the bounded cache;
- on `MESSAGE_UPDATE`, resolve previous state from cache first, Discord store second, merge the partial event payload, save the previous snapshot exactly once when effective content changed, then cache the merged result;
- on `MESSAGE_DELETE`, resolve/snapshot the real message, save a delete record, remove that key from the bounded cache, and return without modifying the event object;
- never mark a real event `otherPluginBypass` and never dispatch a compensating message event.

Pseudocode contract:

```ts
function recordDelete(event: any) {
    const { channelId, messageId } = getEventMessageIdentity(event);
    if (!channelId || !messageId || !normalizeSettings(storage.settings).logDeletes) return;
    const original = messageCache.get(channelId, messageId)?.raw ?? getStoredMessage(channelId, messageId) ?? event.message;
    const snapshot = snapshotMessage(original, channelId);
    if (!snapshot) return;
    saveRecord(createRecord("delete", { ...snapshot, guildId: resolveGuildId(snapshot) }));
    messageCache.delete(channelId, messageId);
}
```

- [ ] **Step 4: Install render-only `createChannelStream` patch**

Discover with `findByName("createChannelStream", false)`. Patch its default export with `instead`, always calling `orig(...args)` first.

From `args[0]`, resolve:
- channel ID;
- `messages.hasMoreBefore` / `messages.hasMoreAfter` when available.

Call `mergeDeletedRows()` with current persisted inline delete records.

The `makeRow` callback must construct the minimal transient message representation accepted by the current native renderer. Prefer Discord's current `MessageRecordUtils.createMessageRecord` if discoverable via `findByProps("createMessageRecord", "updateMessageRecord")`; otherwise use the exact row/message shape verified from `createChannelStream`. Mark it only with:

```ts
message_history_overlay_deleted: true
```

Do **not** set EPHEMERAL (`64`) and do not dispatch/store the object.

If converter discovery or one record conversion fails, log once/bounded and return the original Discord rows for that failed record.

- [ ] **Step 5: Replace tombstone dismissal path**

In the message long-press patch, detect `message.message_history_overlay_deleted === true`.

For a tombstone, inject idempotent actions:

```ts
createActionSheetRow("View Message History", `${records.length} saved records`, ...)
createActionSheetRow("Hide Deleted Message", "Keep it saved, remove it from chat", () => {
    hideInlineDelete(channelId, message.id);
    ActionSheet.hideActionSheet?.();
    requestOverlayRefresh();
})
```

For ordinary messages, preserve existing View/Clear history actions.

Never `splice()` into a reused rows array without checking for existing MessageHistory rows. Use stable plugin-specific keys/labels and return a fresh array where practical.

- [ ] **Step 6: Implement coalesced render refresh**

Use `createRenderRefreshScheduler()` with a short 0-50 ms coalescing delay. Discover the smallest available native/local refresh path during implementation. Acceptable refresh hooks are those that invalidate/recompute channel rows without forging message events. If no safe hook is found, dismissal remains persisted immediately and the row disappears on the next natural render; do not add a Flux fallback.

- [ ] **Step 7: Remove legacy reinjection functions/helpers from `index.ts` and `history.ts`**

Delete:

- synthetic create/update reinjection;
- `injectedDeletedMessages`;
- `recentlyPreservedDeletes`;
- `handledDispatchEvents` logic that exists only to protect self-dispatched events (retain duplicate dispatch protection only if the same real event traverses multiple dispatcher methods in practice);
- batch `*LOAD*MESSAGE*` mutation;
- synthetic-dismiss consumption;
- EPHEMERAL tombstone creation.

- [ ] **Step 8: Run all three harnesses and plugin build**

```bash
npx esbuild plugins/MessageHistory/src/history.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/history.mjs
npx esbuild plugins/MessageHistory/src/capture.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/capture.mjs
npx esbuild plugins/MessageHistory/src/overlay.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/overlay.mjs
npx esbuild plugins/MessageHistory/src/settingsOptions.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/settingsOptions.mjs
node scripts/check-message-history-retention.mjs
node scripts/check-message-history-capture.mjs
node scripts/check-message-history-overlay.mjs
npm run build
```

Expected: all three harnesses print `... ok`; plugin build exits 0.

- [ ] **Step 9: Commit**

```bash
git add plugins/MessageHistory/src/index.ts plugins/MessageHistory/src/history.ts plugins/MessageHistory/src/ui.tsx scripts/check-message-history-overlay.mjs
git commit -m "refactor: render deleted history as chat overlay"
```

---

### Task 5: Remove obsolete reinjection UI/debugging and make clear operations coherent

**Files:**
- Modify: `plugins/MessageHistory/src/settings.tsx`
- Modify: `plugins/MessageHistory/src/types.ts`
- Delete: `plugins/MessageHistory/src/debug.tsx`
- Modify: `plugins/MessageHistory/src/index.ts`

**Interfaces:**
- Produces: plugin-local `clearHistory`/presentation invalidation callback path.
- Removes: `debugReinject`, `ReinjectDebugEvent`, `storage.reinjectDebugEvents` behavior.

- [ ] **Step 1: Add failing source-level assertions**

Extend retention or overlay harness source checks:

```js
for (const token of ["debugReinject", "reinjectDebugEvents", "showReinjectDebugModal", "recordReinjectDebugEvent"]) {
  if (combinedMessageHistorySource.includes(token)) {
    throw new Error(`Expected obsolete reinjection debug surface to be removed: ${token}`);
  }
}
```

Run and confirm RED.

- [ ] **Step 2: Remove reinjection-debug setting/type/UI**

Delete:
- `debugReinject` from settings defaults/normalization and `MessageHistorySettings`;
- debug settings rows/imports/count state;
- `ReinjectDebugEvent` type;
- `debug.tsx`.

Do not migrate or preserve old debug log storage because it is diagnostic data for an architecture that no longer exists.

- [ ] **Step 3: Make clear-history changes invalidate the overlay**

Route settings clear actions through a small exported plugin-local callback/utility instead of writing `storage.historyRecords = []` in isolation, or publish a simple module-local revision callback that settings can invoke. Clearing history must:

```ts
storage.historyRecords = [];
messageCache.clear();
requestOverlayRefresh();
```

Per-message Clear Message History must likewise update persisted records and request overlay refresh. It does not need Discord-store cleanup.

- [ ] **Step 4: Run all harnesses/build and confirm GREEN**

Use the full command set from Task 4 Step 8.

- [ ] **Step 5: Commit**

```bash
git add plugins/MessageHistory/src/settings.tsx plugins/MessageHistory/src/types.ts plugins/MessageHistory/src/index.ts scripts/check-message-history-*.mjs
git rm plugins/MessageHistory/src/debug.tsx
git commit -m "chore: remove legacy reinjection state"
```

---

### Task 6: Put MessageHistory regression harnesses in CI

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes the four compilable pure modules/harnesses from Tasks 1-5.
- Produces a CI step that fails before plugin build on MessageHistory regression failures.

- [ ] **Step 1: Inspect current CI order and add an intentional failing probe locally/mentally**

The final workflow sequence after dependency install/audit must include a MessageHistory regression step before `npm run build`.

- [ ] **Step 2: Add CI regression commands**

Add a named step equivalent to:

```yaml
- name: Test MessageHistory
  run: |
    mkdir -p .codex-tmp/MessageHistory
    npx esbuild plugins/MessageHistory/src/history.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/history.mjs
    npx esbuild plugins/MessageHistory/src/capture.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/capture.mjs
    npx esbuild plugins/MessageHistory/src/overlay.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/overlay.mjs
    npx esbuild plugins/MessageHistory/src/settingsOptions.ts --bundle --platform=node --format=esm --outfile=.codex-tmp/MessageHistory/settingsOptions.mjs
    node scripts/check-message-history-retention.mjs
    node scripts/check-message-history-capture.mjs
    node scripts/check-message-history-overlay.mjs
```

Keep the existing audit/build steps intact.

- [ ] **Step 3: Run equivalent commands plus full build locally when possible**

Expected: all harnesses and `npm run build` succeed.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "test: run MessageHistory regressions in CI"
```

---

### Task 7: Final verification against observed failures and LongScreenshotFix coexistence

**Files:**
- Review: `plugins/MessageHistory/src/index.ts`
- Review: `plugins/MessageHistory/src/history.ts`
- Review: `plugins/MessageHistory/src/capture.ts`
- Review: `plugins/MessageHistory/src/overlay.ts`
- Review: `plugins/LongScreenshotFix/src/index.ts`
- Review: all MessageHistory test scripts

**Interfaces:**
- No new interfaces. This task verifies the complete architecture.

- [ ] **Step 1: Run static forbidden-path scan**

Search MessageHistory for:

```text
MESSAGE_CREATE
otherPluginBypass
injectedDeletedMessages
recentlyPreservedDeletes
message_history_synthetic_deleted
flags: 64
reinject
```

Expected: no production reinjection implementation remains. Any occurrence in migration comments/tests must be reviewed and justified or removed.

- [ ] **Step 2: Run full regression/build suite fresh**

Run the full commands from Task 4 Step 8 followed by:

```bash
npm audit --omit=dev --audit-level=high
```

Expected: all pass.

- [ ] **Step 3: Verify LongScreenshotFix patch composition**

Confirm both plugins patch `createChannelStream` by calling the next/original function first and transforming returned rows. MessageHistory must not assume it owns the only patch. LongScreenshotFix's `load_before` filtering must remain independent of MessageHistory's message-row insertion.

- [ ] **Step 4: Verify exact old-failure scenario in overlay harness**

The harness must demonstrate all of the following in one scenario:

```text
newest window -> correct visible deletes only
load older window -> older deletes appear; existing tombstones do not duplicate/move
hide tombstone A/B/C rapidly -> one coalesced refresh; all three hidden
render again -> A/B/C absent
extend history -> A/B/C still absent
simulate restart from persisted state -> hidden remain absent; non-hidden appear in correct window
```

- [ ] **Step 5: Push branch and inspect GitHub Actions**

Wait only for the current tool response; do not claim success until the workflow run is completed. Inspect the CI job steps and logs on failure.

- [ ] **Step 6: Final review and integrate**

If CI is green and the diff matches the approved spec, merge or fast-forward according to the repo's normal workflow. Report the resulting commit SHA and explicitly call out that the only remaining verification is on-device native renderer behavior: live delete, restart/reopen, older-history loading, and rapid dismissal.
