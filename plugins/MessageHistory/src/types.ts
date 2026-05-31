export type HistoryKind = "edit" | "delete";

export interface MessageHistorySettings {
    logEdits: boolean;
    logDeletes: boolean;
    persistHistory: boolean;
    showDeletedInChannelsAfterRestart: boolean;
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
