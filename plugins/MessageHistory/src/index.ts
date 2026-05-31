import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";

import {
    addRecord,
    clearMessageKindRecords,
    clearMessageRecords,
    createSyntheticDeletedCreateEvent,
    createSyntheticDeletedMessage,
    createRecord,
    getKindRecords,
    getMessageRecords,
    hasVisibleContent,
    normalizeSettings,
    pruneRecords,
    sortOldestByMessageTime,
} from "./history";
import settings from "./settings";
import type { HistoryRecord, MessageSnapshot } from "./types";
import { createActionSheetRow, showHistoryModal } from "./ui";

const unpatches: Array<() => void> = [];
const messageCache = new Map<string, MessageSnapshot>();
const injectedDeletedMessages = new Set<string>();
const pendingReinjectChannels = new Set<string>();
const reinjectAttempts = new Map<string, number>();
const reinjectTimeouts: Array<ReturnType<typeof setTimeout>> = [];
let reinjectInterval: ReturnType<typeof setInterval> | undefined;
const MAX_REINJECT_ATTEMPTS = 5;

const ActionSheet = findByProps("openLazy", "hideActionSheet");
const ChannelStore = findByProps("getChannel", "getDMFromUserId");
const ChannelMessages = findByProps("_channelMessages");
const MessageStore = findByProps("getMessage", "getMessages");
const SelectedChannelStore = findByStoreName("SelectedChannelStore");

function ensureStorage() {
    const nextSettings = normalizeSettings(storage.settings);
    storage.settings = nextSettings;
    storage.historyRecords = pruneRecords(Array.isArray(storage.historyRecords) ? storage.historyRecords : [], nextSettings);

    if (!nextSettings.persistHistory) {
        storage.historyRecords = [];
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

function getEventChannelId(event: any): string | undefined {
    return event?.channelId ?? event?.message?.channel_id ?? event?.message?.channelId;
}

function getEventMessageId(event: any): string | undefined {
    return event?.id ?? event?.message?.id;
}

function looksLikeSyntheticDeletedMessage(message: any): boolean {
    if (!message) return false;
    if (message.message_history_synthetic_deleted === true) return true;

    const flags = Number(message.flags ?? 0);
    const content = typeof message.content === "string" ? message.content : "";
    return (flags & 64) === 64 && content.startsWith("[deleted]");
}

function hasSavedDeleteRecord(channelId: string, messageId: string): boolean {
    return readRecords().some(
        (record) => record.kind === "delete" && record.channelId === channelId && record.messageId === messageId,
    );
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

function getSelectedChannelId(): string | undefined {
    try {
        return SelectedChannelStore?.getChannelId?.() ?? SelectedChannelStore?.getLastSelectedChannelId?.();
    } catch {
        return undefined;
    }
}

function shouldReinjectDeletedMessages() {
    const settingsValue = normalizeSettings(storage.settings);
    return settingsValue.logDeletes && settingsValue.showDeletedInChannelsAfterRestart;
}

function getChannelMessageCache(channelId: string) {
    try {
        return ChannelMessages?.get?.(channelId);
    } catch {
        return null;
    }
}

function hasStoredMessage(channelId: string, messageId: string) {
    try {
        return Boolean(MessageStore?.getMessage?.(channelId, messageId) ?? ChannelMessages?.get?.(channelId)?.get?.(messageId));
    } catch {
        return false;
    }
}

function consumeSyntheticDeletedDismiss(event: any): boolean {
    const channelId = getEventChannelId(event);
    const messageId = getEventMessageId(event);
    if (!channelId || !messageId) return false;

    const key = messageKey(channelId, messageId);
    const storedMessage = getCachedOrStoredMessage(channelId, messageId) ?? event.message;
    const trackedSyntheticMessage = injectedDeletedMessages.has(key) || looksLikeSyntheticDeletedMessage(storedMessage);
    if (!trackedSyntheticMessage || !hasSavedDeleteRecord(channelId, messageId)) return false;

    writeRecords(clearMessageKindRecords({ records: readRecords() }, channelId, messageId, "delete").records);
    injectedDeletedMessages.delete(key);
    reinjectAttempts.delete(key);
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
    const channelId = getEventChannelId(event) ?? firstMessageWithChannel?.channel_id ?? firstMessageWithChannel?.channelId;
    if (!channelId) return;

    const existingIds = new Set(event.messages.map((message: any) => message?.id).filter(Boolean));
    const syntheticMessages: any[] = [];
    const records = sortOldestByMessageTime(
        getKindRecords({ records: readRecords() }, "delete").filter((record) => record.channelId === channelId),
    );

    for (const record of records) {
        const key = messageKey(record.channelId, record.messageId);
        if (injectedDeletedMessages.has(key) || existingIds.has(record.messageId) || hasStoredMessage(record.channelId, record.messageId)) {
            if (existingIds.has(record.messageId) || hasStoredMessage(record.channelId, record.messageId)) injectedDeletedMessages.add(key);
            reinjectAttempts.delete(key);
            continue;
        }

        const syntheticMessage = createSyntheticDeletedMessage(record);
        syntheticMessages.push(syntheticMessage);
        existingIds.add(record.messageId);
        injectedDeletedMessages.add(key);
        reinjectAttempts.delete(key);
        rememberMessage(syntheticMessage, record.channelId);
    }

    if (!syntheticMessages.length) return;
    event.messages = sortMessagesLikeBatch([...event.messages, ...syntheticMessages], event.messages);
}

function reinjectDeletedMessagesForChannel(channelId?: string) {
    if (!channelId || !shouldReinjectDeletedMessages()) return;
    if (!getChannelMessageCache(channelId)) return;

    const records = sortOldestByMessageTime(
        getKindRecords({ records: readRecords() }, "delete").filter((record) => record.channelId === channelId),
    );

    for (const record of records) {
        const key = messageKey(record.channelId, record.messageId);
        if (injectedDeletedMessages.has(key)) continue;
        if (hasStoredMessage(record.channelId, record.messageId)) {
            injectedDeletedMessages.add(key);
            reinjectAttempts.delete(key);
            continue;
        }

        const attempts = reinjectAttempts.get(key) ?? 0;
        if (attempts >= MAX_REINJECT_ATTEMPTS) continue;
        reinjectAttempts.set(key, attempts + 1);

        try {
            const event = createSyntheticDeletedCreateEvent(record);
            FluxDispatcher.dispatch(event);

            if (hasStoredMessage(record.channelId, record.messageId)) {
                injectedDeletedMessages.add(key);
                reinjectAttempts.delete(key);
                rememberMessage(event.message, record.channelId);
                continue;
            }

            const confirmTimeout = setTimeout(() => {
                if (!hasStoredMessage(record.channelId, record.messageId)) return;
                injectedDeletedMessages.add(key);
                reinjectAttempts.delete(key);
                rememberMessage(event.message, record.channelId);
            }, 250);
            reinjectTimeouts.push(confirmTimeout);
        } catch (error) {
            console.error("[MessageHistory] deleted message reinjection failed", error);
        }
    }
}

function getLoadedDeletedRecordChannelIds(): string[] {
    const channelIds = new Set<string>();

    for (const record of getKindRecords({ records: readRecords() }, "delete")) {
        if (getChannelMessageCache(record.channelId)) channelIds.add(record.channelId);
    }

    return [...channelIds];
}

function scheduleLoadedDeletedMessageReinjects() {
    for (const channelId of getLoadedDeletedRecordChannelIds()) {
        scheduleDeletedMessageReinject(channelId);
    }
}

function scheduleDeletedMessageReinject(channelId?: string) {
    if (!channelId || pendingReinjectChannels.has(channelId)) return;
    pendingReinjectChannels.add(channelId);

    const timeout = setTimeout(() => {
        pendingReinjectChannels.delete(channelId);
        reinjectDeletedMessagesForChannel(channelId);
    }, 500);

    reinjectTimeouts.push(timeout);
}

function startDeletedMessageReinjectLoop() {
    scheduleDeletedMessageReinject(getSelectedChannelId());
    scheduleLoadedDeletedMessageReinjects();
    reinjectInterval = setInterval(() => {
        scheduleDeletedMessageReinject(getSelectedChannelId());
        scheduleLoadedDeletedMessageReinjects();
    }, 2500);
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

    const settingsValue = normalizeSettings(storage.settings);
    if (!settingsValue.logDeletes || event.otherPluginBypass || !event.channelId || !event.id) return;

    const original = getCachedOrStoredMessage(event.channelId, event.id);
    if (looksLikeSyntheticDeletedMessage(original)) return;

    const snapshot = snapshotMessage(original, event.channelId);
    if (!snapshot) return;

    const guildId = ChannelStore?.getChannel?.(snapshot.channelId)?.guild_id ?? snapshot.guildId ?? null;
    const record = createRecord("delete", { ...snapshot, guildId });
    saveRecord(record);

    const key = messageKey(snapshot.channelId, snapshot.id);
    injectedDeletedMessages.add(key);
    reinjectAttempts.delete(key);

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

function patchFluxDispatcher() {
    if (!FluxDispatcher?.dispatch) return;

    safePushUnpatch(() =>
        before("dispatch", FluxDispatcher, (args: any[]) => {
            try {
                const event = args[0];
                if (!event?.type) return;

                if (event.type === "MESSAGE_DELETE") {
                    recordDelete(event);
                    return args;
                }

                if (event.type === "MESSAGE_UPDATE" && !event.otherPluginBypass) {
                    recordUpdate(event);
                    return args;
                }

                injectDeletedRecordsIntoMessageBatch(event);
                if (event.message) rememberMessage(event.message, event.channelId);
                rememberMessages(event.messages, event.channelId);
                scheduleDeletedMessageReinject(event.channelId ?? event.message?.channel_id ?? getSelectedChannelId());
                scheduleLoadedDeletedMessageReinjects();
            } catch (error) {
                console.error("[MessageHistory] dispatch capture failed", error);
            }
        }),
    );
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
        startDeletedMessageReinjectLoop();
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
        pendingReinjectChannels.clear();
        reinjectAttempts.clear();
        while (reinjectTimeouts.length) clearTimeout(reinjectTimeouts.pop());
        if (reinjectInterval) {
            clearInterval(reinjectInterval);
            reinjectInterval = undefined;
        }
    },
    settings,
};
