import { findByProps } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";

import { recordReinjectDebugEvent } from "./debug";
import {
    addRecord,
    clearMessageKindRecords,
    clearMessageRecords,
    createSyntheticDeletedMessage,
    createRecord,
    getEventMessageIdentity,
    getKindRecords,
    getMessageRecords,
    hasVisibleContent,
    isSyntheticDeletedMessage,
    normalizeSettings,
    pruneRecords,
    shouldConsumeSyntheticDeletedDismiss,
    sortOldestByMessageTime,
} from "./history";
import settings from "./settings";
import type { HistoryRecord, MessageSnapshot } from "./types";
import { createActionSheetRow, showHistoryModal } from "./ui";

const unpatches: Array<() => void> = [];
const messageCache = new Map<string, MessageSnapshot>();
const injectedDeletedMessages = new Set<string>();
const recentlyPreservedDeletes = new Map<string, number>();
const handledDispatchEvents = new WeakSet<object>();
const FLUX_DISPATCH_METHODS = ["dispatch", "dirtyDispatch", "maybeDispatch"];
const RECENTLY_PRESERVED_DELETE_MS = 1500;

const ActionSheet = findByProps("openLazy", "hideActionSheet");
const ChannelStore = findByProps("getChannel", "getDMFromUserId");
const ChannelMessages = findByProps("_channelMessages");
const MessageStore = findByProps("getMessage", "getMessages");

function ensureStorage() {
    const nextSettings = normalizeSettings(storage.settings);
    storage.settings = nextSettings;
    storage.historyRecords = pruneRecords(Array.isArray(storage.historyRecords) ? storage.historyRecords : [], nextSettings);

    if (!nextSettings.persistHistory) {
        storage.historyRecords = [];
    }

    if (!Array.isArray(storage.reinjectDebugEvents)) {
        storage.reinjectDebugEvents = [];
    }
}

function readRecords(): HistoryRecord[] {
    return Array.isArray(storage.historyRecords) ? storage.historyRecords : [];
}

function writeRecords(records: HistoryRecord[]) {
    const nextSettings = normalizeSettings(storage.settings);
    storage.settings = nextSettings;
    storage.historyRecords = pruneRecords(records, nextSettings);
}

function saveRecord(record: HistoryRecord) {
    const nextSettings = normalizeSettings(storage.settings);
    storage.settings = nextSettings;
    storage.historyRecords = addRecord({ records: readRecords() }, record, nextSettings).records;
}

function safePushUnpatch(register: () => (() => void) | void) {
    try {
        const unpatch = register();
        if (typeof unpatch === "function") unpatches.push(unpatch);
    } catch (error) {
        console.error("[MessageHistory] patch registration failed", error);
    }
}

function messageKey(channelId: string, messageId: string) {
    return `${channelId}:${messageId}`;
}

function hasSavedDeleteRecord(channelId: string, messageId: string): boolean {
    return readRecords().some(
        (record) => record.kind === "delete" && record.channelId === channelId && record.messageId === messageId,
    );
}

function markRecentlyPreservedDelete(key: string) {
    recentlyPreservedDeletes.set(key, Date.now() + RECENTLY_PRESERVED_DELETE_MS);
}

function isRecentlyPreservedDelete(key: string): boolean {
    const expiresAt = recentlyPreservedDeletes.get(key);
    if (!expiresAt) return false;
    if (Date.now() <= expiresAt) return true;

    recentlyPreservedDeletes.delete(key);
    return false;
}

function snapshotMessage(message: any, fallbackChannelId?: string): MessageSnapshot | null {
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

function rememberMessages(messages: any[] | undefined, fallbackChannelId?: string) {
    if (!Array.isArray(messages)) return;
    for (const message of messages) rememberMessage(message, fallbackChannelId);
}

function getCachedOrStoredMessage(channelId: string, messageId: string) {
    const cached = messageCache.get(messageKey(channelId, messageId));
    if (cached?.raw) return cached.raw;

    try {
        return MessageStore?.getMessage?.(channelId, messageId) ?? ChannelMessages?.get?.(channelId)?.get?.(messageId) ?? null;
    } catch {
        return null;
    }
}

function shouldReinjectDeletedMessages() {
    const settingsValue = normalizeSettings(storage.settings);
    return settingsValue.logDeletes && settingsValue.showDeletedInChannelsAfterRestart;
}

function hasStoredMessage(channelId: string, messageId: string) {
    try {
        return Boolean(MessageStore?.getMessage?.(channelId, messageId) ?? ChannelMessages?.get?.(channelId)?.get?.(messageId));
    } catch {
        return false;
    }
}

function consumeSyntheticDeletedDismiss(event: any): boolean {
    const { channelId, messageId } = getEventMessageIdentity(event);
    if (!channelId || !messageId) return false;

    const key = messageKey(channelId, messageId);
    const storedMessage = getCachedOrStoredMessage(channelId, messageId) ?? event.message;
    const trackedSyntheticMessage = injectedDeletedMessages.has(key) || isSyntheticDeletedMessage(storedMessage);
    const protectedRecentDelete = isRecentlyPreservedDelete(key) && !isSyntheticDeletedMessage(event.message);
    if (
        !shouldConsumeSyntheticDeletedDismiss({
            hasSavedDeleteRecord: hasSavedDeleteRecord(channelId, messageId),
            trackedSyntheticMessage,
            protectedRecentDelete,
        })
    ) {
        return false;
    }

    writeRecords(clearMessageKindRecords({ records: readRecords() }, channelId, messageId, "delete").records);
    injectedDeletedMessages.delete(key);
    recentlyPreservedDeletes.delete(key);
    messageCache.delete(key);
    return true;
}

function isMessageBatchEvent(event: any): boolean {
    return (
        typeof event?.type === "string" &&
        event.type.includes("LOAD") &&
        event.type.includes("MESSAGE") &&
        Array.isArray(event.messages)
    );
}

function getMessageLikeTimestamp(message: any): number {
    const timestamp = message?.timestamp ?? message?.edited_timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
    if (typeof timestamp === "string") {
        const parsedDate = Date.parse(timestamp);
        if (Number.isFinite(parsedDate)) return parsedDate;

        const parsedNumber = Number(timestamp);
        if (Number.isFinite(parsedNumber)) return parsedNumber;
    }

    return timestampFromSnowflake(message?.id) ?? 0;
}

function timestampFromSnowflake(id: string | undefined): number | undefined {
    if (!id || !/^\d+$/.test(id)) return undefined;

    const snowflake = Number(id);
    if (!Number.isFinite(snowflake) || snowflake <= 0) return undefined;

    const timestamp = Math.floor(snowflake / 4_194_304) + 1_420_070_400_000;
    return Number.isFinite(timestamp) && timestamp > 1_420_070_400_000 ? timestamp : undefined;
}

function sortMessagesLikeBatch(messages: any[], referenceMessages: any[]): any[] {
    const first = getMessageLikeTimestamp(referenceMessages[0]);
    const last = getMessageLikeTimestamp(referenceMessages[referenceMessages.length - 1]);
    const descending = first > 0 && last > 0 && first > last;

    return [...messages].sort((a, b) => {
        const delta = getMessageLikeTimestamp(a) - getMessageLikeTimestamp(b);
        return descending ? -delta : delta;
    });
}

function injectDeletedRecordsIntoMessageBatch(event: any) {
    if (!isMessageBatchEvent(event) || !shouldReinjectDeletedMessages()) return;

    // Load batches are the only dispatcher path that can place historical rows near their original timestamp.
    const firstMessageWithChannel = event.messages.find((message: any) => message?.channel_id ?? message?.channelId);
    const channelId = getEventMessageIdentity(event).channelId ?? firstMessageWithChannel?.channel_id ?? firstMessageWithChannel?.channelId;
    if (!channelId) return;

    const existingIds = new Set(event.messages.map((message: any) => message?.id).filter(Boolean));
    const syntheticMessages: any[] = [];
    const records = sortOldestByMessageTime(
        getKindRecords({ records: readRecords() }, "delete").filter((record) => record.channelId === channelId),
    );

    for (const record of records) {
        const key = messageKey(record.channelId, record.messageId);
        const alreadyInBatch = existingIds.has(record.messageId);
        const alreadyStored = hasStoredMessage(record.channelId, record.messageId);

        if (alreadyInBatch || alreadyStored) {
            injectedDeletedMessages.add(key);
            continue;
        }

        // Do not skip only because this set remembers an earlier reinjection. Mobile can briefly render
        // a row, replace the loaded list, and then need the same deleted row injected into a later batch.
        injectedDeletedMessages.delete(key);

        const syntheticMessage = createSyntheticDeletedMessage(record);
        syntheticMessages.push(syntheticMessage);
        existingIds.add(record.messageId);
        injectedDeletedMessages.add(key);
        rememberMessage(syntheticMessage, record.channelId);
    }

    if (!syntheticMessages.length) return;
    event.messages = sortMessagesLikeBatch([...event.messages, ...syntheticMessages], event.messages);
    recordReinjectDebugEvent("batchInject", event, { injectedDeletes: syntheticMessages.length, recordsForChannel: records.length });
}

function recordUpdate(event: any) {
    const settingsValue = normalizeSettings(storage.settings);
    const next = snapshotMessage(event.message, event.channelId);
    if (!next) return;

    const key = messageKey(next.channelId, next.id);
    const cachedPrevious = messageCache.get(key);
    const original = cachedPrevious ? null : getCachedOrStoredMessage(next.channelId, next.id);
    const previous = cachedPrevious ?? snapshotMessage(original, next.channelId);

    if (settingsValue.logEdits && previous && previous.content !== next.content) {
        saveRecord(createRecord("edit", previous));
    }

    messageCache.set(key, next);
}

function recordDelete(event: any) {
    if (consumeSyntheticDeletedDismiss(event)) return;

    const { channelId, messageId } = getEventMessageIdentity(event);
    const settingsValue = normalizeSettings(storage.settings);
    if (!settingsValue.logDeletes || event.otherPluginBypass || !channelId || !messageId) return;

    const original = getCachedOrStoredMessage(channelId, messageId) ?? event.message;
    const key = messageKey(channelId, messageId);
    if (isSyntheticDeletedMessage(original)) {
        if (isRecentlyPreservedDelete(key)) {
            event.message = original;
            event.type = "MESSAGE_UPDATE";
            event.channelId = channelId;
            event.optimistic = false;
            event.sendMessageOptions = {};
            event.isPushNotification = false;
            event.otherPluginBypass = true;
        }
        return;
    }

    const snapshot = snapshotMessage(original, channelId);
    if (!snapshot) return;

    const guildId = ChannelStore?.getChannel?.(snapshot.channelId)?.guild_id ?? snapshot.guildId ?? null;
    const record = createRecord("delete", { ...snapshot, guildId });
    saveRecord(record);

    markRecentlyPreservedDelete(key);
    injectedDeletedMessages.add(key);

    event.message = {
        ...original,
        ...createSyntheticDeletedMessage(record),
        message_reference: original?.message_reference ?? original?.messageReference ?? null,
    };
    event.type = "MESSAGE_UPDATE";
    event.channelId = snapshot.channelId;
    event.optimistic = false;
    event.sendMessageOptions = {};
    event.isPushNotification = false;
}

function markDispatchEventHandled(event: any): boolean {
    if (!event || typeof event !== "object") return false;
    if (handledDispatchEvents.has(event)) return true;

    handledDispatchEvents.add(event);
    return false;
}

function handleDispatchEvent(method: string, event: any) {
    if (!event?.type || markDispatchEventHandled(event)) return;

    recordReinjectDebugEvent(method, event);

    if (event.type === "MESSAGE_DELETE") {
        recordDelete(event);
        return;
    }

    if (event.type === "MESSAGE_UPDATE" && !event.otherPluginBypass) {
        recordUpdate(event);
        return;
    }

    injectDeletedRecordsIntoMessageBatch(event);
    if (event.message) rememberMessage(event.message, event.channelId);
    rememberMessages(event.messages, event.channelId);
}

function patchFluxDispatcher() {
    const methods = FLUX_DISPATCH_METHODS.filter((method) => typeof FluxDispatcher?.[method] === "function");
    if (!methods.length) return;

    for (const method of methods) {
        safePushUnpatch(() =>
            before(method, FluxDispatcher, (args: any[]) => {
                try {
                    handleDispatchEvent(method, args[0]);
                } catch (error) {
                    console.error(`[MessageHistory] ${method} capture failed`, error);
                }

                return args;
            }),
        );
    }
}

function findReplyButton(row: any) {
    return row?.props?.label?.toLowerCase?.() === "reply";
}

function patchActionSheet() {
    if (!ActionSheet?.openLazy) return;

    safePushUnpatch(() =>
        before("openLazy", ActionSheet, ([component, args, actionMessage]) => {
            const message = actionMessage?.message;
            const channelId = message?.channel_id ?? message?.channelId;
            if (args !== "MessageLongPressActionSheet" || !message?.id || !channelId) return;

            component
                .then((instance: any) => {
                    let unpatch: (() => void) | undefined;
                    unpatch = after("default", instance, (_, comp) => {
                        try {
                            React.useEffect(() => () => unpatch?.(), []);

                            const rows = findInReactTree(comp, (node) => node?.find?.(findReplyButton));
                            if (!rows) return comp;

                            const records = getMessageRecords({ records: readRecords() }, channelId, message.id);
                            if (!records.length) return comp;

                            const position = Math.max(rows.findIndex(findReplyButton), 0);
                            rows.splice(
                                position,
                                0,
                                createActionSheetRow("View Edit History", `${records.length} saved records`, () => {
                                    ActionSheet.hideActionSheet?.();
                                    showHistoryModal(records);
                                }),
                                createActionSheetRow("Clear Message History", "Remove saved records for this message", () => {
                                    writeRecords(clearMessageRecords({ records: readRecords() }, channelId, message.id).records);
                                    ActionSheet.hideActionSheet?.();
                                    showToast("Message history cleared");
                                }),
                            );

                            return comp;
                        } catch (error) {
                            console.error("[MessageHistory] action sheet render failed", error);
                            return comp;
                        }
                    });
                })
                .catch((error: unknown) => {
                    console.error("[MessageHistory] action sheet load failed", error);
                    showToast("MessageHistory: action sheet unavailable");
                });
        }),
    );
}

export default {
    onLoad() {
        ensureStorage();
        patchFluxDispatcher();
        patchActionSheet();
    },
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
        injectedDeletedMessages.clear();
        recentlyPreservedDeletes.clear();
    },
    settings,
};
