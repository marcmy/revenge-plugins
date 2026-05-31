export type HistoryKind = "edit" | "delete";

export interface MessageHistorySettings {
    logEdits: boolean;
    logDeletes: boolean;
    persistHistory: boolean;
    showDeletedInChannelsAfterRestart: boolean;
    debugReinject: boolean;
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
    messageTimestamp?: number | null;
}

export interface HistoryState {
    records: HistoryRecord[];
}

export interface ReinjectDebugEvent {
    id: string;
    timestamp: number;
    method: string;
    type: string;
    channelId?: string | null;
    messageId?: string | null;
    messageChannelId?: string | null;
    messagesLength?: number | null;
    firstMessageId?: string | null;
    firstMessageTimestamp?: string | number | null;
    lastMessageId?: string | null;
    lastMessageTimestamp?: string | number | null;
    hasMessage: boolean;
    hasMessages: boolean;
    hasSavedDeletesForChannel: boolean;
    savedDeletesForChannel: number;
    eventKeys: string[];
    extra?: Record<string, string | number | boolean | null>;
}
