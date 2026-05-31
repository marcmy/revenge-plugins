import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";

import {
    addRecord,
    clearMessageRecords,
    createRecord,
    createSyntheticDeletedMessage,
    getKindRecords,
    getMessageRecords,
    hasVisibleContent,
    normalizeSettings,
    pruneRecords,
} from "./history";
import settings from "./settings";
import type { HistoryRecord, MessageSnapshot } from "./types";
import { createActionSheetRow, showHistoryModal } from "./ui";

const unpatches: Array<() => void> = [];
const messageCache = new Map<string, MessageSnapshot>();
const injectedDeletedMessages = new Set<string>();
const pendingReinjectChannels = new Set<string>();
const reinjectTimeouts: Array<ReturnType<typeof setTimeout>> = [];
let reinjectInterval: ReturnType<typeof setInterval> | undefined;

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

function reinjectDeletedMessagesForChannel(channelId?: string) {
    if (!channelId || !shouldReinjectDeletedMessages()) return;
    if (!getChannelMessageCache(channelId)) return;

    const records = getKindRecords({ records: readRecords() }, "delete")
        .filter((record) => record.channelId === channelId)
        .reverse();

    for (const record of records) {
        const key = messageKey(record.channelId, record.messageId);
        if (injectedDeletedMessages.has(key) || hasStoredMessage(record.channelId, record.messageId)) continue;

        const message = createSyntheticDeletedMessage(record);
        injectedDeletedMessages.add(key);

        try {
            FluxDispatcher.dispatch({
                type: "MESSAGE_UPDATE",
                channelId: record.channelId,
                message,
                optimistic: false,
                sendMessageOptions: {},
                isPushNotification: false,
                otherPluginBypass: true,
            });
            rememberMessage(message, record.channelId);
        } catch (error) {
            injectedDeletedMessages.delete(key);
            console.error("[MessageHistory] deleted message reinjection failed", error);
        }
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
    reinjectInterval = setInterval(() => scheduleDeletedMessageReinject(getSelectedChannelId()), 2500);
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
    const settingsValue = normalizeSettings(storage.settings);
    if (!settingsValue.logDeletes || event.otherPluginBypass || !event.channelId || !event.id) return;

    const original = getCachedOrStoredMessage(event.channelId, event.id);
    const snapshot = snapshotMessage(original, event.channelId);
    if (!snapshot) return;

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

                if (event.message) rememberMessage(event.message, event.channelId);
                rememberMessages(event.messages, event.channelId);
                scheduleDeletedMessageReinject(event.channelId ?? event.message?.channel_id ?? getSelectedChannelId());
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
        while (reinjectTimeouts.length) clearTimeout(reinjectTimeouts.pop());
        if (reinjectInterval) {
            clearInterval(reinjectInterval);
            reinjectInterval = undefined;
        }
    },
    settings,
};
