import { findByName, findByProps } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { after, before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";

import {
    RecentMessageCache,
    contentChanged,
    mergeMessageUpdate,
    snapshotMessage,
} from "./capture";
import {
    addRecord,
    clearMessageRecords,
    createRecord,
    getEventMessageIdentity,
    getInlineDeleteRecords,
    getMessageRecords,
    getRecordMessageTimestamp,
    getRenderableDeleteRecords,
    hasVisibleContent,
    normalizeSettings,
    pruneRecords,
    setDeleteInlineHidden,
} from "./history";
import { createRenderRefreshScheduler, mergeDeletedRows } from "./overlay";
import { bindMessageHistoryRuntime } from "./runtime";
import settings from "./settings";
import type { HistoryRecord, MessageSnapshot } from "./types";
import { createActionSheetRow, showHistoryModal } from "./ui";

const unpatches: Array<() => void> = [];
const messageCache = new RecentMessageCache();
const handledDispatchEvents = new WeakSet<object>();
const overlayMessages = new WeakSet<object>();
const currentSessionDeleteRecordIds = new Set<string>();
const FLUX_DISPATCH_METHODS = ["dispatch", "dirtyDispatch", "maybeDispatch"];
const HISTORY_ACTION_LABELS = new Set(["View Edit History", "View Message History", "Clear Message History", "Hide Deleted Message"]);

const ActionSheet = findByProps("openLazy", "hideActionSheet");
const ChannelStore = findByProps("getChannel", "getDMFromUserId");
const ChannelMessages = findByProps("_channelMessages");
const MessageStore = findByProps("getMessage", "getMessages");
const MessageRecordUtils = findByProps("createMessageRecord", "updateMessageRecord");
const RowGeneratorConstants = findByProps("RowType", "LoadingType", "SeparatorType", "Changeset");

let unbindRuntime: (() => void) | undefined;

function createOverlayRefresh() {
    return createRenderRefreshScheduler(() => {
        try {
            MessageStore?.emitChange?.();
        } catch (error) {
            console.error("[MessageHistory] chat refresh failed", error);
        }
    });
}

let overlayRefresh = createOverlayRefresh();

function resetOverlayRefresh() {
    overlayRefresh.dispose();
    overlayRefresh = createOverlayRefresh();
}

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

function writeRecords(records: HistoryRecord[], refresh = false) {
    const nextSettings = normalizeSettings(storage.settings);
    storage.settings = nextSettings;
    storage.historyRecords = pruneRecords(records, nextSettings);
    if (refresh) overlayRefresh.request();
}

function saveRecord(record: HistoryRecord) {
    const nextSettings = normalizeSettings(storage.settings);
    storage.settings = nextSettings;
    storage.historyRecords = addRecord({ records: readRecords() }, record, nextSettings).records;
}

function clearAllHistory() {
    storage.historyRecords = [];
    currentSessionDeleteRecordIds.clear();
    messageCache.clear();
    overlayRefresh.request();
}

function safePushUnpatch(register: () => (() => void) | void) {
    try {
        const unpatch = register();
        if (typeof unpatch === "function") unpatches.push(unpatch);
    } catch (error) {
        console.error("[MessageHistory] patch registration failed", error);
    }
}

function getStoredMessage(channelId: string, messageId: string) {
    try {
        return MessageStore?.getMessage?.(channelId, messageId) ?? ChannelMessages?.get?.(channelId)?.get?.(messageId) ?? null;
    } catch {
        return null;
    }
}

function getPreviousSnapshot(channelId: string, messageId: string): MessageSnapshot | null {
    return messageCache.get(channelId, messageId) ?? snapshotMessage(getStoredMessage(channelId, messageId), channelId);
}

function snapshotToMergeableMessage(snapshot: MessageSnapshot): any {
    return {
        id: snapshot.id,
        channel_id: snapshot.channelId,
        guild_id: snapshot.guildId ?? null,
        content: snapshot.content,
        attachments: [...snapshot.attachments],
        embeds: [...snapshot.embeds],
        timestamp: snapshot.timestamp,
        author: {
            id: snapshot.authorId ?? "0",
            username: snapshot.authorUsername ?? "Unknown User",
        },
    };
}

function rememberMessage(message: any, fallbackChannelId?: string) {
    return messageCache.set(message, fallbackChannelId);
}

function rememberMessages(messages: any[] | undefined, fallbackChannelId?: string) {
    if (!Array.isArray(messages)) return;
    for (const message of messages) rememberMessage(message, fallbackChannelId);
}

function recordUpdate(event: any) {
    const settingsValue = normalizeSettings(storage.settings);
    const { channelId: eventChannelId, messageId } = getEventMessageIdentity(event);
    const incoming = event?.message;
    const channelId = eventChannelId ?? incoming?.channel_id ?? incoming?.channelId;
    if (!incoming || !channelId || !messageId) return;

    const previous = getPreviousSnapshot(channelId, messageId);
    if (!previous) {
        rememberMessage(incoming, channelId);
        return;
    }

    const merged = mergeMessageUpdate(snapshotToMergeableMessage(previous), incoming, channelId);
    const next = snapshotMessage(merged, channelId);

    if (settingsValue.logEdits && contentChanged(previous, next)) {
        saveRecord(createRecord("edit", previous));
    }

    if (next) rememberMessage(merged, channelId);
}

function recordDelete(event: any) {
    const { channelId, messageId } = getEventMessageIdentity(event);
    if (!channelId || !messageId) return;

    const cached = messageCache.get(channelId, messageId);
    messageCache.delete(channelId, messageId);

    const settingsValue = normalizeSettings(storage.settings);
    if (!settingsValue.logDeletes) return;

    const original = cached?.raw ?? getStoredMessage(channelId, messageId) ?? event.message;
    const snapshot = cached ?? snapshotMessage(original, channelId);
    if (!snapshot || !hasVisibleContent(snapshot)) return;

    const guildId = ChannelStore?.getChannel?.(snapshot.channelId)?.guild_id ?? snapshot.guildId ?? null;
    const record = createRecord("delete", { ...snapshot, guildId });
    currentSessionDeleteRecordIds.add(record.id);
    saveRecord(record);
    overlayRefresh.request();
}

function markDispatchEventHandled(event: any): boolean {
    if (!event || typeof event !== "object") return false;
    if (handledDispatchEvents.has(event)) return true;
    handledDispatchEvents.add(event);
    return false;
}

function handleDispatchEvent(event: any) {
    if (!event?.type || markDispatchEventHandled(event)) return;

    if (event.type === "MESSAGE_DELETE") {
        recordDelete(event);
        return;
    }

    if (event.type === "MESSAGE_UPDATE") {
        recordUpdate(event);
        return;
    }

    if (event.message) rememberMessage(event.message, event.channelId);
    rememberMessages(event.messages, event.channelId);
}

function patchFluxDispatcher() {
    const methods = FLUX_DISPATCH_METHODS.filter((method) => typeof FluxDispatcher?.[method] === "function");
    for (const method of methods) {
        safePushUnpatch(() =>
            before(method, FluxDispatcher, (args: any[]) => {
                try {
                    handleDispatchEvent(args[0]);
                } catch (error) {
                    console.error(`[MessageHistory] ${method} capture failed`, error);
                }
                return args;
            }),
        );
    }
}

function formatDeletedContent(content: string): string {
    if (!content) return "[deleted]";
    return content.startsWith("[deleted]") ? content : `[deleted] ${content}`;
}

function createOverlayMessage(record: HistoryRecord): any | null {
    if (typeof MessageRecordUtils?.createMessageRecord !== "function") return null;

    try {
        const raw = {
            id: record.messageId,
            channel_id: record.channelId,
            guild_id: record.guildId ?? null,
            content: formatDeletedContent(record.content),
            attachments: Array.isArray(record.attachments) ? record.attachments : [],
            embeds: Array.isArray(record.embeds) ? record.embeds : [],
            flags: 0,
            type: 0,
            timestamp: new Date(getRecordMessageTimestamp(record)).toISOString(),
            edited_timestamp: null,
            author: {
                id: record.authorId ?? "0",
                username: record.authorUsername ?? "Unknown User",
            },
            mentions: [],
            mention_roles: [],
            mention_channels: [],
            mention_everyone: false,
            message_reference: null,
            pinned: false,
            tts: false,
            message_history_overlay_deleted: true,
        };
        const message = MessageRecordUtils.createMessageRecord(raw);
        if (message && typeof message === "object") overlayMessages.add(message);
        return message;
    } catch (error) {
        console.error("[MessageHistory] deleted overlay message conversion failed", error);
        return null;
    }
}

function createOverlayRow(record: HistoryRecord, rows: any[], input: any): any | null {
    const message = createOverlayMessage(record);
    if (!message) return null;

    const template = rows.find((row: any) => row?.message && row?.rowType === (RowGeneratorConstants?.RowType?.MESSAGE ?? 1))
        ?? rows.find((row: any) => row?.message);

    return {
        ...(template ?? {}),
        roleStyle: template?.roleStyle ?? input?.roleStyle,
        message,
        isSystemDM: false,
        isFirst: true,
        isEditing: false,
        separatorBefore: true,
        canAddNewReactions: false,
        alwaysShowAddReaction: false,
        renderContentOnly: false,
        pushFeedbackType: undefined,
        canReply: false,
        canEdit: false,
        rowType: RowGeneratorConstants?.RowType?.MESSAGE ?? template?.rowType ?? 1,
        changeType: RowGeneratorConstants?.Changeset?.INSERT ?? 1,
        showContentInventoryEntryFallbackEmbed: false,
    };
}

function shouldRenderDeletedRows(): boolean {
    return normalizeSettings(storage.settings).logDeletes;
}

function patchDeletedMessageOverlay() {
    let createChannelStream: any;
    try {
        createChannelStream = findByName("createChannelStream", false);
    } catch {}

    if (!createChannelStream || typeof createChannelStream.default !== "function") {
        console.error("[MessageHistory] createChannelStream unavailable; inline deleted rows disabled");
        return;
    }

    safePushUnpatch(() =>
        instead("default", createChannelStream, (args, orig) => {
            const rows = orig(...args);
            try {
                if (!Array.isArray(rows) || !shouldRenderDeletedRows()) return rows;

                const input = args?.[0];
                const channelId = input?.channel?.id ?? input?.messages?.channelId;
                if (!channelId) return rows;

                const settingsValue = normalizeSettings(storage.settings);
                const records = getRenderableDeleteRecords(
                    { records: readRecords() },
                    channelId,
                    {
                        showSavedAfterRestart: settingsValue.showDeletedInChannelsAfterRestart,
                        currentSessionRecordIds: currentSessionDeleteRecordIds,
                    },
                );
                if (!records.length) return rows;

                return mergeDeletedRows(
                    rows,
                    records,
                    (record) => createOverlayRow(record, rows, input),
                    {
                        hasMoreBefore: Boolean(input?.messages?.hasMoreBefore),
                        hasMoreAfter: Boolean(input?.messages?.hasMoreAfter),
                    },
                );
            } catch (error) {
                console.error("[MessageHistory] deleted row overlay failed", error);
                return rows;
            }
        }),
    );
}

function findReplyButton(row: any) {
    return row?.props?.label?.toLowerCase?.() === "reply";
}

function isHistoryAction(row: any): boolean {
    return HISTORY_ACTION_LABELS.has(row?.props?.label);
}

function isOverlayMessage(message: any, channelId: string): boolean {
    if (message && typeof message === "object" && overlayMessages.has(message)) return true;
    if (!message?.id) return false;

    try {
        if (getStoredMessage(channelId, message.id)) return false;
    } catch {}

    return getInlineDeleteRecords({ records: readRecords() }, channelId).some(
        (record) => record.messageId === message.id && formatDeletedContent(record.content) === message.content,
    );
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
                            if (!rows || rows.some(isHistoryAction)) return comp;

                            const records = getMessageRecords({ records: readRecords() }, channelId, message.id);
                            if (!records.length) return comp;

                            const position = Math.max(rows.findIndex(findReplyButton), 0);
                            const overlay = isOverlayMessage(message, channelId);
                            const additions = overlay
                                ? [
                                    createActionSheetRow("View Message History", `${records.length} saved records`, () => {
                                        ActionSheet.hideActionSheet?.();
                                        showHistoryModal(records);
                                    }),
                                    createActionSheetRow("Hide Deleted Message", "Keep it saved, remove it from chat", () => {
                                        writeRecords(
                                            setDeleteInlineHidden({ records: readRecords() }, channelId, message.id, true).records,
                                            true,
                                        );
                                        ActionSheet.hideActionSheet?.();
                                        showToast("Deleted message hidden");
                                    }),
                                ]
                                : [
                                    createActionSheetRow("View Edit History", `${records.length} saved records`, () => {
                                        ActionSheet.hideActionSheet?.();
                                        showHistoryModal(records);
                                    }),
                                    createActionSheetRow("Clear Message History", "Remove saved records for this message", () => {
                                        writeRecords(clearMessageRecords({ records: readRecords() }, channelId, message.id).records, true);
                                        ActionSheet.hideActionSheet?.();
                                        showToast("Message history cleared");
                                    }),
                                ];

                            rows.splice(position, 0, ...additions);
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
        currentSessionDeleteRecordIds.clear();
        ensureStorage();
        resetOverlayRefresh();
        unbindRuntime?.();
        unbindRuntime = bindMessageHistoryRuntime({
            clearAllHistory,
            requestOverlayRefresh: () => overlayRefresh.request(),
        });
        patchFluxDispatcher();
        patchDeletedMessageOverlay();
        patchActionSheet();
    },
    onUnload() {
        while (unpatches.length) {
            try {
                unpatches.pop()?.();
            } catch {}
        }

        unbindRuntime?.();
        unbindRuntime = undefined;
        overlayRefresh.dispose();
        if (!normalizeSettings(storage.settings).persistHistory) {
            storage.historyRecords = [];
        }
        currentSessionDeleteRecordIds.clear();
        messageCache.clear();
    },
    settings,
};
