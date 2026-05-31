import type { HistoryRecord, HistoryState, MessageHistorySettings, MessageSnapshot } from "./types";

export const DEFAULT_SETTINGS: MessageHistorySettings = {
    logEdits: true,
    logDeletes: true,
    persistHistory: false,
    showDeletedInChannelsAfterRestart: false,
    maxTotalRecords: 200,
    maxRecordsPerChannel: 50,
    maxRecordsPerMessage: 10,
    maxAgeDays: 3,
};

export function normalizeSettings(input?: Partial<MessageHistorySettings>): MessageHistorySettings {
    const settings = { ...DEFAULT_SETTINGS, ...(input ?? {}) };

    return {
        logEdits: settings.logEdits !== false,
        logDeletes: settings.logDeletes !== false,
        persistHistory: settings.persistHistory === true,
        showDeletedInChannelsAfterRestart: settings.showDeletedInChannelsAfterRestart === true,
        maxTotalRecords: clampPositiveInteger(settings.maxTotalRecords, DEFAULT_SETTINGS.maxTotalRecords),
        maxRecordsPerChannel: clampPositiveInteger(settings.maxRecordsPerChannel, DEFAULT_SETTINGS.maxRecordsPerChannel),
        maxRecordsPerMessage: clampPositiveInteger(settings.maxRecordsPerMessage, DEFAULT_SETTINGS.maxRecordsPerMessage),
        maxAgeDays: clampPositiveInteger(settings.maxAgeDays, DEFAULT_SETTINGS.maxAgeDays),
    };
}

export function createRecord(kind: HistoryRecord["kind"], snapshot: MessageSnapshot, now = Date.now()): HistoryRecord {
    const messageTimestamp = parseMessageTimestamp(snapshot.timestamp) ?? timestampFromSnowflake(snapshot.id) ?? now;

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
        messageTimestamp,
    };
}

export function addRecord(
    state: HistoryState,
    record: HistoryRecord,
    settings?: Partial<MessageHistorySettings>,
    now = Date.now(),
): HistoryState {
    return {
        records: pruneRecords([record, ...(state.records ?? [])], settings, now),
    };
}

export function pruneRecords(
    records: HistoryRecord[],
    settingsInput?: Partial<MessageHistorySettings>,
    now = Date.now(),
): HistoryRecord[] {
    const settings = normalizeSettings(settingsInput);
    const minTimestamp = now - settings.maxAgeDays * 24 * 60 * 60 * 1000;
    let next = sortNewestFirst(records).filter((record) => Number(record.timestamp) >= minTimestamp);

    const byMessage = new Map<string, number>();
    next = next.filter((record) => {
        const key = messageKey(record.channelId, record.messageId);
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

export function getMessageRecords(state: HistoryState, channelId: string, messageId: string): HistoryRecord[] {
    return sortNewestFirst(state.records ?? []).filter(
        (record) => record.channelId === channelId && record.messageId === messageId,
    );
}

export function createSyntheticDeletedMessage(record: HistoryRecord): any {
    const timestamp = new Date(getRecordMessageTimestamp(record)).toISOString();

    return {
        id: record.messageId,
        channel_id: record.channelId,
        guild_id: record.guildId ?? null,
        content: formatDeletedContent(record.content),
        attachments: Array.isArray(record.attachments) ? record.attachments : [],
        embeds: Array.isArray(record.embeds) ? record.embeds : [],
        flags: 64,
        type: 0,
        timestamp,
        edited_timestamp: null,
        author: {
            id: record.authorId ?? "0",
            username: record.authorUsername ?? "Unknown User",
        },
        message_reference: null,
        message_history_synthetic_deleted: true,
    };
}

export function createSyntheticDeletedCreateEvent(record: HistoryRecord): any {
    return {
        type: "MESSAGE_CREATE",
        channelId: record.channelId,
        message: createSyntheticDeletedMessage(record),
        optimistic: false,
        sendMessageOptions: {},
        isPushNotification: false,
        otherPluginBypass: true,
    };
}

export function getEventMessageIdentity(event: any): { channelId?: string; messageId?: string } {
    const message = event?.message;

    return {
        channelId: event?.channelId ?? event?.channel_id ?? message?.channel_id ?? message?.channelId,
        messageId: event?.id ?? event?.messageId ?? event?.message_id ?? message?.id,
    };
}

export function isSyntheticDeletedMessage(message: any): boolean {
    if (!message) return false;
    if (message.message_history_synthetic_deleted === true) return true;

    const flags = Number(message.flags ?? 0);
    const content = typeof message.content === "string" ? message.content : "";
    return (flags & 64) === 64 && content.startsWith("[deleted]");
}

export function shouldConsumeSyntheticDeletedDismiss(input: {
    hasSavedDeleteRecord: boolean;
    trackedSyntheticMessage: boolean;
    protectedRecentDelete?: boolean;
}): boolean {
    return input.hasSavedDeleteRecord && input.trackedSyntheticMessage && input.protectedRecentDelete !== true;
}

export function getKindRecords(state: HistoryState, kind: HistoryRecord["kind"]): HistoryRecord[] {
    return sortNewestFirst(state.records ?? []).filter((record) => record.kind === kind);
}

export function clearMessageKindRecords(
    state: HistoryState,
    channelId: string,
    messageId: string,
    kind: HistoryRecord["kind"],
): HistoryState {
    return {
        records: (state.records ?? []).filter(
            (record) => record.kind !== kind || record.channelId !== channelId || record.messageId !== messageId,
        ),
    };
}

export function clearMessageRecords(state: HistoryState, channelId: string, messageId: string): HistoryState {
    return {
        records: (state.records ?? []).filter(
            (record) => record.channelId !== channelId || record.messageId !== messageId,
        ),
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

export function getRecordMessageTimestamp(record: HistoryRecord): number {
    const storedTimestamp = Number(record.messageTimestamp);
    if (Number.isFinite(storedTimestamp) && storedTimestamp > 0) return storedTimestamp;

    return timestampFromSnowflake(record.messageId) ?? record.timestamp;
}

export function sortOldestByMessageTime(records: HistoryRecord[]): HistoryRecord[] {
    return [...records].sort((a, b) => {
        const timeDelta = getRecordMessageTimestamp(a) - getRecordMessageTimestamp(b);
        return timeDelta || a.timestamp - b.timestamp;
    });
}

function clampPositiveInteger(value: unknown, fallback: number): number {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function messageKey(channelId: string, messageId: string): string {
    return `${channelId}:${messageId}`;
}

function sortNewestFirst(records: HistoryRecord[]): HistoryRecord[] {
    return [...records].sort((a, b) => b.timestamp - a.timestamp);
}

function formatDeletedContent(content: string): string {
    if (!content) return "[deleted]";
    return content.startsWith("[deleted]") ? content : `[deleted] ${content}`;
}

function parseMessageTimestamp(value: MessageSnapshot["timestamp"]): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return undefined;

    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) return parsedDate;

    const parsedNumber = Number(value);
    return Number.isFinite(parsedNumber) ? parsedNumber : undefined;
}

function timestampFromSnowflake(id: string): number | undefined {
    if (!/^\d+$/.test(id)) return undefined;

    const snowflake = Number(id);
    if (!Number.isFinite(snowflake) || snowflake <= 0) return undefined;

    const timestamp = Math.floor(snowflake / 4_194_304) + 1_420_070_400_000;
    return Number.isFinite(timestamp) && timestamp > 1_420_070_400_000 ? timestamp : undefined;
}
