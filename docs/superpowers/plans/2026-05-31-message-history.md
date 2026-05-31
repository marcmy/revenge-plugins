# Message History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new Revenge plugin that logs message edits and deletes without writing edit history into message content.

**Architecture:** Add `plugins/MessageHistory` as a separate plugin. Keep unstable Discord mobile patching in `src/index.ts`, history retention in pure helpers under `src/history.ts`, and UI/settings in focused TSX files. Use plugin `storage` for optional persistence and enforce age, per-message, per-channel, and total caps after every write.

**Tech Stack:** TypeScript, TSX with React Native JSX, Vendetta/Revenge APIs, Rollup build script already present in the repo, esbuild for isolated helper verification.

---

## File Structure

- Create `plugins/MessageHistory/manifest.json`: plugin metadata and entrypoint.
- Create `plugins/MessageHistory/src/types.ts`: shared settings, message snapshot, and history record types.
- Create `plugins/MessageHistory/src/history.ts`: defaults, normalization, record insertion, pruning, lookup, clearing, and cache helpers.
- Create `plugins/MessageHistory/src/ui.tsx`: modal content and action-sheet row insertion.
- Create `plugins/MessageHistory/src/settings.tsx`: settings UI and clear-history control.
- Create `plugins/MessageHistory/src/index.ts`: lifecycle, FluxDispatcher patch, message cache, delete preservation, action-sheet patch.
- Modify `README.md`: add install link after the plugin builds successfully.

## Task 1: Add Pure History Model

**Files:**
- Create: `plugins/MessageHistory/src/types.ts`
- Create: `plugins/MessageHistory/src/history.ts`

- [ ] **Step 1: Create shared types**

Add `plugins/MessageHistory/src/types.ts`:

```ts
export type HistoryKind = "edit" | "delete";

export interface MessageHistorySettings {
    logEdits: boolean;
    logDeletes: boolean;
    persistHistory: boolean;
    maxTotalRecords: number;
    maxRecordsPerChannel: number;
    maxRecordsPerMessage: number;
    maxAgeDays: number;
}

export interface MessageSnapshot {
    id: string;
    channelId: string;
    guildId?: string | null;
    authorId?: string | null;
    authorUsername?: string | null;
    content: string;
    attachments: any[];
    embeds: any[];
    timestamp?: string | number | null;
    raw: any;
}

export interface HistoryRecord {
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

export interface HistoryState {
    records: HistoryRecord[];
}
```

- [ ] **Step 2: Create retention helpers**

Add `plugins/MessageHistory/src/history.ts`:

```ts
import type { HistoryRecord, HistoryState, MessageHistorySettings, MessageSnapshot } from "./types";

export const DEFAULT_SETTINGS: MessageHistorySettings = {
    logEdits: true,
    logDeletes: true,
    persistHistory: false,
    maxTotalRecords: 200,
    maxRecordsPerChannel: 50,
    maxRecordsPerMessage: 10,
    maxAgeDays: 3,
};

export function normalizeSettings(input: Partial<MessageHistorySettings> | undefined): MessageHistorySettings {
    const settings = { ...DEFAULT_SETTINGS, ...(input ?? {}) };
    return {
        logEdits: settings.logEdits !== false,
        logDeletes: settings.logDeletes !== false,
        persistHistory: settings.persistHistory === true,
        maxTotalRecords: Math.max(1, Math.floor(Number(settings.maxTotalRecords) || DEFAULT_SETTINGS.maxTotalRecords)),
        maxRecordsPerChannel: Math.max(1, Math.floor(Number(settings.maxRecordsPerChannel) || DEFAULT_SETTINGS.maxRecordsPerChannel)),
        maxRecordsPerMessage: Math.max(1, Math.floor(Number(settings.maxRecordsPerMessage) || DEFAULT_SETTINGS.maxRecordsPerMessage)),
        maxAgeDays: Math.max(1, Math.floor(Number(settings.maxAgeDays) || DEFAULT_SETTINGS.maxAgeDays)),
    };
}

export function createRecord(kind: HistoryRecord["kind"], snapshot: MessageSnapshot, now = Date.now()): HistoryRecord {
    return {
        id: `${kind}:${snapshot.channelId}:${snapshot.id}:${now}`,
        kind,
        channelId: snapshot.channelId,
        guildId: snapshot.guildId ?? null,
        messageId: snapshot.id,
        authorId: snapshot.authorId ?? null,
        authorUsername: snapshot.authorUsername ?? null,
        content: snapshot.content ?? "",
        attachments: Array.isArray(snapshot.attachments) ? snapshot.attachments : [],
        embeds: Array.isArray(snapshot.embeds) ? snapshot.embeds : [],
        timestamp: now,
    };
}

function sortNewestFirst(records: HistoryRecord[]): HistoryRecord[] {
    return [...records].sort((a, b) => b.timestamp - a.timestamp);
}

export function pruneRecords(records: HistoryRecord[], settingsInput?: Partial<MessageHistorySettings>, now = Date.now()): HistoryRecord[] {
    const settings = normalizeSettings(settingsInput);
    const minTimestamp = now - settings.maxAgeDays * 24 * 60 * 60 * 1000;
    let next = sortNewestFirst(records).filter((record) => Number(record.timestamp) >= minTimestamp);

    const byMessage = new Map<string, number>();
    next = next.filter((record) => {
        const key = `${record.channelId}:${record.messageId}`;
        const count = byMessage.get(key) ?? 0;
        if (count >= settings.maxRecordsPerMessage) return false;
        byMessage.set(key, count + 1);
        return true;
    });

    const byChannel = new Map<string, number>();
    next = next.filter((record) => {
        const count = byChannel.get(record.channelId) ?? 0;
        if (count >= settings.maxRecordsPerChannel) return false;
        byChannel.set(record.channelId, count + 1);
        return true;
    });

    return next.slice(0, settings.maxTotalRecords);
}

export function addRecord(state: HistoryState, record: HistoryRecord, settings?: Partial<MessageHistorySettings>, now = Date.now()): HistoryState {
    return {
        records: pruneRecords([record, ...(state.records ?? [])], settings, now),
    };
}

export function getMessageRecords(state: HistoryState, channelId: string, messageId: string): HistoryRecord[] {
    return sortNewestFirst(state.records ?? []).filter((record) => record.channelId === channelId && record.messageId === messageId);
}

export function clearMessageRecords(state: HistoryState, channelId: string, messageId: string): HistoryState {
    return {
        records: (state.records ?? []).filter((record) => record.channelId !== channelId || record.messageId !== messageId),
    };
}

export function clearChannelRecords(state: HistoryState, channelId: string): HistoryState {
    return {
        records: (state.records ?? []).filter((record) => record.channelId !== channelId),
    };
}

export function hasVisibleContent(snapshot: Pick<MessageSnapshot, "content" | "attachments" | "embeds">): boolean {
    return Boolean(snapshot.content || snapshot.attachments?.length || snapshot.embeds?.length);
}
```

- [ ] **Step 3: Verify retention helpers with esbuild and Node**

Run:

```powershell
New-Item -ItemType Directory -Force -Path .codex-tmp\MessageHistory | Out-Null
npx esbuild plugins\MessageHistory\src\history.ts --bundle --platform=node --format=esm --outfile=.codex-tmp\MessageHistory\history.mjs
node --input-type=module -e "import { addRecord, createRecord, getMessageRecords } from './.codex-tmp/MessageHistory/history.mjs'; const base={id:'m1',channelId:'c1',guildId:'g1',authorId:'u1',authorUsername:'marc',content:'v',attachments:[],embeds:[],raw:{}}; let state={records:[]}; for (let i=0;i<12;i++) state=addRecord(state, createRecord('edit',{...base,content:'v'+i}, 1000+i), {maxTotalRecords:200,maxRecordsPerChannel:50,maxRecordsPerMessage:10,maxAgeDays:3}, 1000+i); if (getMessageRecords(state,'c1','m1').length !== 10) throw new Error('per-message limit failed'); console.log('history retention ok');"
```

Expected output includes:

```text
history retention ok
```

## Task 2: Add Plugin Shell And Settings

**Files:**
- Create: `plugins/MessageHistory/manifest.json`
- Create: `plugins/MessageHistory/src/settings.tsx`
- Create: `plugins/MessageHistory/src/index.ts`

- [ ] **Step 1: Add manifest**

Add `plugins/MessageHistory/manifest.json`:

```json
{
  "name": "MessageHistory",
  "description": "Logs edited and deleted messages without exposing edit history in message content.",
  "authors": [
    {
      "name": "marcmy",
      "id": "92076581404545024"
    }
  ],
  "main": "src/index.ts",
  "vendetta": {
    "icon": "ic_history_24px"
  }
}
```

- [ ] **Step 2: Add settings UI**

Add `plugins/MessageHistory/src/settings.tsx`:

```tsx
import { ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { ErrorBoundary, Forms } from "@vendetta/ui/components";
import { showConfirmationAlert } from "@vendetta/ui/alerts";

import { DEFAULT_SETTINGS, normalizeSettings } from "./history";

const clearHistory = () => {
    showConfirmationAlert({
        title: "Clear Message History",
        content: "Remove all saved edit and delete history for this plugin?",
        confirmText: "Clear",
        cancelText: "Cancel",
        onConfirm: () => {
            storage.historyRecords = [];
        },
    });
};

function ensureSettings() {
    const settings = normalizeSettings(storage.settings);
    storage.settings = settings;
    storage.historyRecords ??= [];
    return settings;
}

export default function Settings() {
    useProxy(storage);
    const settings = ensureSettings();

    const set = <K extends keyof typeof DEFAULT_SETTINGS>(key: K, value: typeof DEFAULT_SETTINGS[K]) => {
        storage.settings = normalizeSettings({ ...settings, [key]: value });
    };

    return (
        <ErrorBoundary>
            <ReactNative.ScrollView>
                <Forms.FormSwitchRow
                    label="Log edits"
                    subLabel="Keep previous versions when messages are edited"
                    value={settings.logEdits}
                    onValueChange={(value) => set("logEdits", value)}
                />
                <Forms.FormSwitchRow
                    label="Log deletes"
                    subLabel="Keep deleted messages visible locally"
                    value={settings.logDeletes}
                    onValueChange={(value) => set("logDeletes", value)}
                />
                <Forms.FormSwitchRow
                    label="Persist history"
                    subLabel="Keep history after closing the app"
                    value={settings.persistHistory}
                    onValueChange={(value) => set("persistHistory", value)}
                />
                <Forms.FormRow
                    label="Max total records"
                    subLabel={String(settings.maxTotalRecords)}
                    onPress={() => setNumber("maxTotalRecords", "Max total records")}
                />
                <Forms.FormRow
                    label="Max records per channel"
                    subLabel={String(settings.maxRecordsPerChannel)}
                    onPress={() => setNumber("maxRecordsPerChannel", "Max records per channel")}
                />
                <Forms.FormRow
                    label="Max records per message"
                    subLabel={String(settings.maxRecordsPerMessage)}
                    onPress={() => setNumber("maxRecordsPerMessage", "Max records per message")}
                />
                <Forms.FormRow
                    label="Max age in days"
                    subLabel={String(settings.maxAgeDays)}
                    onPress={() => setNumber("maxAgeDays", "Max age in days")}
                />
                <Forms.FormRow
                    label="Clear all history"
                    subLabel={`${storage.historyRecords?.length ?? 0} saved records`}
                    onPress={clearHistory}
                />
            </ReactNative.ScrollView>
        </ErrorBoundary>
    );
}
```

- [ ] **Step 3: Add minimal lifecycle**

Add `plugins/MessageHistory/src/index.ts`:

```ts
import { storage } from "@vendetta/plugin";

import { normalizeSettings, pruneRecords } from "./history";
import settings from "./settings";

function ensureStorage() {
    const nextSettings = normalizeSettings(storage.settings);
    storage.settings = nextSettings;
    storage.historyRecords = pruneRecords(Array.isArray(storage.historyRecords) ? storage.historyRecords : [], nextSettings);
    if (!nextSettings.persistHistory) storage.historyRecords = [];
}

export default {
    onLoad() {
        ensureStorage();
    },
    onUnload() {},
    settings,
};
```

- [ ] **Step 4: Verify shell build**

Run:

```powershell
npm run build
```

Expected output includes:

```text
Successfully built MessageHistory!
```

Numeric settings use `showInputAlert` from `@vendetta/ui/alerts` so the plan does not depend on a runtime-specific input row component.

## Task 3: Add History Modal And Action-Sheet Rows

**Files:**
- Create: `plugins/MessageHistory/src/ui.tsx`
- Modify: `plugins/MessageHistory/src/index.ts`

- [ ] **Step 1: Add UI helpers**

Add `plugins/MessageHistory/src/ui.tsx`:

```tsx
import { React, ReactNative } from "@vendetta/metro/common";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showCustomAlert } from "@vendetta/ui/alerts";
import { Forms, General } from "@vendetta/ui/components";

import type { HistoryRecord } from "./types";

const { ScrollView, View } = General;

function formatTime(timestamp: number): string {
    try {
        return new Date(timestamp).toLocaleString();
    } catch {
        return String(timestamp);
    }
}

function recordTitle(record: HistoryRecord): string {
    return record.kind === "delete" ? "Deleted message" : "Previous edit";
}

function HistoryModal({ records }: { records: HistoryRecord[] }) {
    return (
        <ScrollView style={{ maxHeight: 520 }}>
            <Forms.FormSection title="Message History">
                {records.map((record) => (
                    <Forms.FormRow
                        key={record.id}
                        label={recordTitle(record)}
                        subLabel={`${formatTime(record.timestamp)}${record.content ? `\n${record.content}` : ""}`}
                    />
                ))}
            </Forms.FormSection>
            <View style={{ height: 24 }} />
        </ScrollView>
    );
}

export function showHistoryModal(records: HistoryRecord[]) {
    showCustomAlert(() => <HistoryModal records={records} />, {});
}

export function createActionSheetRow(label: string, subLabel: string, onPress: () => void) {
    const ActionSheetRow = Forms.ActionSheetRow ?? Forms.FormRow;
    const icon = getAssetIDByName("ic_history_24px") || getAssetIDByName("ic_edit_24px");

    return (
        <ActionSheetRow
            label={label}
            subLabel={subLabel}
            icon={ActionSheetRow.Icon ? <ActionSheetRow.Icon source={icon} /> : undefined}
            leading={!ActionSheetRow.Icon ? <Forms.FormRow.Icon source={icon} /> : undefined}
            onPress={onPress}
        />
    );
}
```

- [ ] **Step 2: Wire action-sheet patch placeholders**

Modify `plugins/MessageHistory/src/index.ts` to include unpatch tracking and imports without changing behavior:

```ts
import { findByProps } from "@vendetta/metro";
import { React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";

import { getMessageRecords, normalizeSettings, pruneRecords } from "./history";
import { createActionSheetRow, showHistoryModal } from "./ui";
import settings from "./settings";

const unpatches: Array<() => void> = [];

function ensureStorage() {
    const nextSettings = normalizeSettings(storage.settings);
    storage.settings = nextSettings;
    storage.historyRecords = pruneRecords(Array.isArray(storage.historyRecords) ? storage.historyRecords : [], nextSettings);
    if (!nextSettings.persistHistory) storage.historyRecords = [];
}

function safePushUnpatch(register: () => (() => void) | void) {
    try {
        const unpatch = register();
        if (typeof unpatch === "function") unpatches.push(unpatch);
    } catch (error) {
        console.error("[MessageHistory] patch registration failed", error);
    }
}

function findReplyButton(row: any) {
    return row?.props?.label?.toLowerCase?.() === "reply";
}

function patchActionSheet() {
    const ActionSheet = findByProps("openLazy", "hideActionSheet");
    if (!ActionSheet?.openLazy) return;

    safePushUnpatch(() =>
        before("openLazy", ActionSheet, ([component, args, actionMessage]) => {
            const message = actionMessage?.message;
            if (args !== "MessageLongPressActionSheet" || !message?.id || !message?.channel_id) return;

            component.then((instance: any) => {
                let unpatch: (() => void) | undefined;
                unpatch = after("default", instance, (_, comp) => {
                    React.useEffect(() => () => unpatch?.(), []);

                    const rows = findInReactTree(comp, (node) => node?.find?.(findReplyButton));
                    if (!rows) return comp;

                    const records = getMessageRecords({ records: storage.historyRecords ?? [] }, message.channel_id, message.id);
                    if (!records.length) return comp;

                    const position = Math.max(rows.findIndex(findReplyButton), 0);
                    rows.splice(
                        position,
                        0,
                        createActionSheetRow("View Edit History", `${records.length} saved records`, () => {
                            ActionSheet.hideActionSheet?.();
                            showHistoryModal(records);
                        }),
                    );

                    return comp;
                });
            }).catch((error: unknown) => {
                console.error("[MessageHistory] action sheet load failed", error);
                showToast("MessageHistory: action sheet unavailable");
            });
        }),
    );
}

export default {
    onLoad() {
        ensureStorage();
        patchActionSheet();
    },
    onUnload() {
        while (unpatches.length) {
            try {
                unpatches.pop()?.();
            } catch {}
        }
    },
    settings,
};
```

- [ ] **Step 3: Verify build after UI wiring**

Run:

```powershell
npm run build
```

Expected output includes:

```text
Successfully built MessageHistory!
```

## Task 4: Capture Message Edits Without Content Mutation

**Files:**
- Modify: `plugins/MessageHistory/src/index.ts`

- [ ] **Step 1: Add message cache and snapshot helpers**

Add these helpers above `patchActionSheet()` in `plugins/MessageHistory/src/index.ts`:

```ts
import type { HistoryRecord, MessageSnapshot } from "./types";
import { addRecord, createRecord, hasVisibleContent } from "./history";

const messageCache = new Map<string, MessageSnapshot>();

function messageKey(channelId: string, messageId: string) {
    return `${channelId}:${messageId}`;
}

function snapshotMessage(message: any, fallbackChannelId?: string): MessageSnapshot | null {
    const id = message?.id;
    const channelId = message?.channel_id ?? message?.channelId ?? fallbackChannelId;
    if (!id || !channelId) return null;

    const snapshot: MessageSnapshot = {
        id,
        channelId,
        guildId: message?.guild_id ?? message?.guildId ?? null,
        authorId: message?.author?.id ?? message?.authorId ?? null,
        authorUsername: message?.author?.username ?? message?.author?.globalName ?? null,
        content: message?.content ?? "",
        attachments: Array.isArray(message?.attachments) ? message.attachments : [],
        embeds: Array.isArray(message?.embeds) ? message.embeds : [],
        timestamp: message?.timestamp ?? message?.edited_timestamp ?? null,
        raw: message,
    };

    return hasVisibleContent(snapshot) ? snapshot : null;
}

function rememberMessage(message: any, fallbackChannelId?: string) {
    const snapshot = snapshotMessage(message, fallbackChannelId);
    if (!snapshot) return null;
    messageCache.set(messageKey(snapshot.channelId, snapshot.id), snapshot);
    return snapshot;
}

function saveRecord(record: HistoryRecord) {
    const nextSettings = normalizeSettings(storage.settings);
    storage.settings = nextSettings;
    storage.historyRecords = addRecord({ records: storage.historyRecords ?? [] }, record, nextSettings).records;
}
```

- [ ] **Step 2: Add FluxDispatcher patch for updates**

Add this function below the helpers:

```ts
function patchFluxDispatcher() {
    if (!FluxDispatcher?.dispatch) return;

    safePushUnpatch(() =>
        before("dispatch", FluxDispatcher, (args: any[]) => {
            try {
                const event = args[0];
                if (!event?.type) return;

                if (event.type === "MESSAGE_CREATE" && event.message) {
                    rememberMessage(event.message, event.channelId);
                    return;
                }

                if (event.type !== "MESSAGE_UPDATE") return;
                const settingsValue = normalizeSettings(storage.settings);
                if (!settingsValue.logEdits) {
                    rememberMessage(event.message, event.channelId);
                    return;
                }

                const next = snapshotMessage(event.message, event.channelId);
                if (!next) return;

                const key = messageKey(next.channelId, next.id);
                const previous = messageCache.get(key);
                if (previous && previous.content !== next.content) {
                    saveRecord(createRecord("edit", previous));
                }

                messageCache.set(key, next);
            } catch (error) {
                console.error("[MessageHistory] update capture failed", error);
            }
        }),
    );
}
```

Use the existing static import pattern from the repo: `import { FluxDispatcher } from "@vendetta/metro/common";`.

- [ ] **Step 3: Register the dispatcher patch**

Update `onLoad()`:

```ts
onLoad() {
    ensureStorage();
    patchFluxDispatcher();
    patchActionSheet();
},
```

- [ ] **Step 4: Verify build**

Run:

```powershell
npm run build
```

Expected output includes:

```text
Successfully built MessageHistory!
```

## Task 5: Preserve Deleted Messages Locally

**Files:**
- Modify: `plugins/MessageHistory/src/index.ts`

- [ ] **Step 1: Add store lookups**

Add module-level store lookup helpers:

```ts
const ChannelStore = findByProps("getChannel", "getDMFromUserId");
const ChannelMessages = findByProps("_channelMessages");
const MessageStore = findByProps("getMessage", "getMessages");
```

Add this helper near `rememberMessage()`:

```ts
function getCachedOrStoredMessage(channelId: string, messageId: string) {
    const cached = messageCache.get(messageKey(channelId, messageId));
    if (cached?.raw) return cached.raw;

    try {
        return MessageStore?.getMessage?.(channelId, messageId) ?? ChannelMessages?.get?.(channelId)?.get?.(messageId) ?? null;
    } catch {
        return null;
    }
}
```

- [ ] **Step 2: Extend dispatch patch for deletes**

Inside the `before("dispatch", FluxDispatcher, ...)` callback, before the `MESSAGE_UPDATE` branch, add:

```ts
if (event.type === "MESSAGE_DELETE") {
    const settingsValue = normalizeSettings(storage.settings);
    if (!settingsValue.logDeletes || event.otherPluginBypass) return;

    const original = getCachedOrStoredMessage(event.channelId, event.id);
    const snapshot = snapshotMessage(original, event.channelId);
    if (!snapshot || original?.author?.bot) return;

    saveRecord(createRecord("delete", snapshot));

    const guildId = ChannelStore?.getChannel?.(snapshot.channelId)?.guild_id ?? snapshot.guildId ?? null;
    event.message = {
        ...original,
        content: original?.content ? `[deleted] ${original.content}` : "[deleted]",
        channel_id: snapshot.channelId,
        guild_id: guildId,
        message_reference: original?.message_reference ?? original?.messageReference ?? null,
        flags: 64,
    };
    event.type = "MESSAGE_UPDATE";
    event.channelId = snapshot.channelId;
    event.optimistic = false;
    event.sendMessageOptions = {};
    event.isPushNotification = false;
    return args;
}
```

- [ ] **Step 3: Verify delete branch build**

Run:

```powershell
npm run build
```

Expected output includes:

```text
Successfully built MessageHistory!
```

## Task 6: Finish Settings, Persistence, And README

**Files:**
- Modify: `plugins/MessageHistory/src/settings.tsx`
- Modify: `plugins/MessageHistory/src/index.ts`
- Modify: `README.md`

- [ ] **Step 1: Make persistence toggle clear volatile history on unload**

Update `onUnload()` in `plugins/MessageHistory/src/index.ts`:

```ts
onUnload() {
    while (unpatches.length) {
        try {
            unpatches.pop()?.();
        } catch {}
    }

    if (!normalizeSettings(storage.settings).persistHistory) {
        storage.historyRecords = [];
    }

    messageCache.clear();
},
```

- [ ] **Step 2: Add clear message action**

Update the row insertion in `patchActionSheet()` so it inserts both rows:

```ts
const position = Math.max(rows.findIndex(findReplyButton), 0);
rows.splice(
    position,
    0,
    createActionSheetRow("View Edit History", `${records.length} saved records`, () => {
        ActionSheet.hideActionSheet?.();
        showHistoryModal(records);
    }),
    createActionSheetRow("Clear Message History", "Remove saved records for this message", () => {
        storage.historyRecords = clearMessageRecords({ records: storage.historyRecords ?? [] }, message.channel_id, message.id).records;
        ActionSheet.hideActionSheet?.();
    }),
);
```

Statically import `clearMessageRecords` from `./history`; avoid dynamic `require` in bundled plugin code.

- [ ] **Step 3: Add README install link**

Modify `README.md` plugin list:

```md
## Plugins List:
- SplitLargeMessages: [Install Link](https://marcmy.github.io/revenge-plugins/SplitLargeMessages/)
- HideChannelListShortcuts: [Install Link](https://marcmy.github.io/revenge-plugins/HideChannelListShortcuts/)
- MessageHistory: [Install Link](https://marcmy.github.io/revenge-plugins/MessageHistory/)
```

- [ ] **Step 4: Final build**

Run:

```powershell
npm run build
```

Expected output includes:

```text
Successfully built HideChannelListShortcuts!
Successfully built SplitLargeMessages!
Successfully built MessageHistory!
```

## Task 7: Manual Mobile Verification

**Files:**
- Inspect: `dist/MessageHistory/manifest.json`
- Inspect: `dist/MessageHistory/index.js`

- [ ] **Step 1: Inspect generated manifest**

Run:

```powershell
Get-Content dist\MessageHistory\manifest.json
```

Expected JSON has:

```json
{"name":"MessageHistory","description":"Logs edited and deleted messages without exposing edit history in message content.","authors":[{"name":"marcmy","id":"92076581404545024"}],"main":"index.js","vendetta":{"icon":"ic_history_24px"}}
```

- [ ] **Step 2: Confirm built JavaScript exists**

Run:

```powershell
Get-Item dist\MessageHistory\index.js | Select-Object FullName,Length
```

Expected: file exists and `Length` is greater than `0`.

- [ ] **Step 3: Install and test in Revenge**

Use:

```text
https://marcmy.github.io/revenge-plugins/MessageHistory/
```

Manual checks:

- Edit a message once. The visible message should show only the new content.
- Edit the same message again. The outgoing edit box should contain only the current message text, not old history.
- Long-press the message. `View Edit History` should show prior versions.
- Delete a message. A local `[deleted]` copy should remain if delete logging is enabled.
- Turn off `Persist history`, reload the app, and confirm history is gone.
- Turn on `Persist history`, reload the app, and confirm history remains until retention limits remove old records.

## Self-Review

- Spec coverage: edit logging, delete logging, persistence, retention caps, settings, UI, and build verification are covered.
- Placeholder scan: no unresolved placeholders remain.
- Type consistency: `HistoryRecord`, `MessageSnapshot`, `MessageHistorySettings`, and helper names are consistent across tasks.
- Known risk: direct tapping on the `(edited)` marker is not in this initial plan because Revenge mobile patch points are not stable from available repo context. The long-press modal provides the same no-content-leak behavior with a safer mobile patch.
