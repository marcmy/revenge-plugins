import type { MessageSnapshot } from "./types";

export const MESSAGE_CACHE_LIMIT = 750;

export function messageKey(channelId: string, messageId: string): string {
    return `${channelId}:${messageId}`;
}

export function snapshotMessage(message: any, fallbackChannelId?: string): MessageSnapshot | null {
    const id = message?.id;
    const channelId = message?.channel_id ?? message?.channelId ?? fallbackChannelId;
    if (!id || !channelId || message?.author?.bot) return null;

    return {
        id,
        channelId,
        guildId: message?.guild_id ?? message?.guildId ?? null,
        authorId: message?.author?.id ?? message?.authorId ?? null,
        authorUsername: message?.author?.username ?? message?.author?.globalName ?? null,
        content: typeof message?.content === "string" ? message.content : "",
        attachments: Array.isArray(message?.attachments) ? [...message.attachments] : [],
        embeds: Array.isArray(message?.embeds) ? [...message.embeds] : [],
        timestamp: message?.timestamp ?? message?.edited_timestamp ?? null,
        raw: message,
    };
}

export function mergeMessageUpdate(previous: any, patch: any, fallbackChannelId?: string): any {
    if (!previous) return patch;
    if (!patch) return previous;

    const channelId =
        patch.channel_id ?? patch.channelId ?? previous.channel_id ?? previous.channelId ?? fallbackChannelId;
    const merged = {
        ...previous,
        ...patch,
        channel_id: channelId,
        author: patch.author ?? previous.author,
        attachments: patch.attachments ?? previous.attachments ?? [],
        embeds: patch.embeds ?? previous.embeds ?? [],
    };

    if (!Object.prototype.hasOwnProperty.call(patch, "content")) {
        merged.content = previous.content ?? "";
    }

    return merged;
}

export function contentChanged(previous: MessageSnapshot | null, next: MessageSnapshot | null): boolean {
    return Boolean(previous && next && previous.content !== next.content);
}

export class RecentMessageCache {
    private readonly entries = new Map<string, MessageSnapshot>();

    constructor(private readonly limit = MESSAGE_CACHE_LIMIT) {}

    get size(): number {
        return this.entries.size;
    }

    get(channelId: string, messageId: string): MessageSnapshot | undefined {
        const key = messageKey(channelId, messageId);
        const snapshot = this.entries.get(key);
        if (!snapshot) return undefined;

        this.entries.delete(key);
        this.entries.set(key, snapshot);
        return snapshot;
    }

    set(message: any, fallbackChannelId?: string): MessageSnapshot | null {
        const snapshot = snapshotMessage(message, fallbackChannelId);
        if (!snapshot) return null;

        const key = messageKey(snapshot.channelId, snapshot.id);
        this.entries.delete(key);
        this.entries.set(key, snapshot);

        while (this.entries.size > this.limit) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey === undefined) break;
            this.entries.delete(oldestKey);
        }

        return snapshot;
    }

    delete(channelId: string, messageId: string): void {
        this.entries.delete(messageKey(channelId, messageId));
    }

    clear(): void {
        this.entries.clear();
    }
}
