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

export function normalizeSettings(input?: Partial<MessageHistorySettings>): MessageHistorySettings {
    const settings = { ...DEFAULT_SETTINGS, ...(input ?? {}) };

    return {
        logEdits: settings.logEdits !== false,
        logDeletes: settings.logDeletes !== false,
        persistHistory: settings.persistHistory === true,
        maxTotalRecords: clampPositiveInteger(settings.maxTotalRecords, DEFAULT_SETTINGS.maxTotalRecords),
        maxRecordsPerChannel: clampPositiveInteger(settings.maxRecordsPerChannel, DEFAULT_SETTINGS.maxRecordsPerChannel),
        maxRecordsPerMessage: clampPositiveInteger(settings.maxRecordsPerMessage, DEFAULT_SETTINGS.maxRecordsPerMessage),
        maxAgeDays: clampPositiveInteger(settings.maxAgeDays, DEFAULT_SETTINGS.maxAgeDays),
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

export function getKindRecords(state: HistoryState, kind: HistoryRecord["kind"]): HistoryRecord[] {
    return sortNewestFirst(state.records ?? []).filter((record) => record.kind === kind);
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
