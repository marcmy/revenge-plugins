import { findByProps } from "@vendetta/metro";
import { constants } from "@vendetta/metro/common";

const DISCORD_EPOCH = 1420070400000n;

const PermissionStore = findByProps("getChannelPermissions", "can") as any;
const ChannelStore = (
    findByProps("getChannel", "getDMFromUserId") ??
    findByProps("getChannel")
) as any;
const ChannelTypeModule = findByProps("ChannelTypes") as any;
const ChannelTypes = ChannelTypeModule?.ChannelTypes ?? {};

const rawPermissionCan = typeof PermissionStore?.can === "function"
    ? PermissionStore.can.bind(PermissionStore)
    : undefined;

const VIEW_CHANNEL = constants?.Permissions?.VIEW_CHANNEL;

const TYPE_DM = ChannelTypes.DM ?? 1;
const TYPE_GROUP_DM = ChannelTypes.GROUP_DM ?? 3;
const TYPE_GUILD_CATEGORY = ChannelTypes.GUILD_CATEGORY ?? 4;
const TYPE_GUILD_TEXT = ChannelTypes.GUILD_TEXT ?? 0;
const TYPE_GUILD_VOICE = ChannelTypes.GUILD_VOICE ?? 2;
const TYPE_GUILD_ANNOUNCEMENT = ChannelTypes.GUILD_ANNOUNCEMENT ?? 5;
const TYPE_GUILD_STAGE_VOICE = ChannelTypes.GUILD_STAGE_VOICE ?? 13;
const TYPE_GUILD_FORUM = ChannelTypes.GUILD_FORUM ?? 15;
const TYPE_GUILD_MEDIA = ChannelTypes.GUILD_MEDIA ?? 16;

const SKIPPED_TYPES = new Set([
    TYPE_DM,
    TYPE_GROUP_DM,
    TYPE_GUILD_CATEGORY,
]);

const TEXT_LIKE_TYPES = new Set([
    TYPE_GUILD_TEXT,
    TYPE_GUILD_ANNOUNCEMENT,
    TYPE_GUILD_FORUM,
    TYPE_GUILD_MEDIA,
]);

const VOICE_LIKE_TYPES = new Set([
    TYPE_GUILD_VOICE,
    TYPE_GUILD_STAGE_VOICE,
]);

export type HiddenChannelMetadata = {
    id: string;
    name: string;
    type: number | undefined;
    typeLabel: string;
    topic: string;
    createdAt: number | null;
    lastMessageAt: number | null;
    lastPinAt: number | null;
};

export function getChannel(channelOrId: any): any | undefined {
    if (!channelOrId) return undefined;
    if (typeof channelOrId === "string") {
        try {
            return ChannelStore?.getChannel?.(channelOrId);
        } catch {
            return undefined;
        }
    }

    if (typeof channelOrId === "object") {
        if (channelOrId.id && channelOrId.type != null) return channelOrId;
        const id = channelOrId.channelId ?? channelOrId.channel_id;
        if (typeof id === "string") {
            try {
                return ChannelStore?.getChannel?.(id);
            } catch {
                return undefined;
            }
        }
    }

    return undefined;
}

export function canViewChannel(channelOrId: any): boolean {
    const channel = getChannel(channelOrId);
    if (!channel) return true;
    if (!rawPermissionCan || VIEW_CHANNEL == null) return true;

    try {
        return !!rawPermissionCan(VIEW_CHANNEL, channel);
    } catch {
        return true;
    }
}

export function isHiddenChannel(channelOrId: any): boolean {
    const channel = getChannel(channelOrId);
    if (!channel) return false;
    if (SKIPPED_TYPES.has(channel.type)) return false;
    if (!(channel.guild_id ?? channel.guildId)) return false;
    return !canViewChannel(channel);
}

export function isTextLikeChannel(channelOrId: any): boolean {
    const channel = getChannel(channelOrId);
    if (!channel) return false;
    if (typeof channel.isGuildText === "function" && channel.isGuildText()) return true;
    if (typeof channel.isForumChannel === "function" && channel.isForumChannel()) return true;
    return TEXT_LIKE_TYPES.has(channel.type);
}

export function isVoiceLikeChannel(channelOrId: any): boolean {
    const channel = getChannel(channelOrId);
    if (!channel) return false;
    if (typeof channel.isGuildVoice === "function" && channel.isGuildVoice()) return true;
    if (typeof channel.isGuildStageVoice === "function" && channel.isGuildStageVoice()) return true;
    return VOICE_LIKE_TYPES.has(channel.type);
}

export function snowflakeTimestamp(id: any): number | null {
    if (id == null) return null;
    try {
        const snowflake = BigInt(String(id));
        return Number((snowflake >> 22n) + DISCORD_EPOCH);
    } catch {
        return null;
    }
}

function normalizeTimestamp(value: any): number | null {
    if (value == null) return null;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

export function getChannelTypeLabel(channelOrId: any): string {
    const channel = getChannel(channelOrId);
    if (!channel) return "channel";
    if (isVoiceLikeChannel(channel)) {
        return channel.type === TYPE_GUILD_STAGE_VOICE ? "stage" : "voice";
    }
    switch (channel.type) {
        case TYPE_GUILD_ANNOUNCEMENT: return "announcement";
        case TYPE_GUILD_FORUM: return "forum";
        case TYPE_GUILD_MEDIA: return "media";
        case TYPE_GUILD_TEXT: return "text";
        default: return "channel";
    }
}

export function getHiddenChannelMetadata(channelOrId: any): HiddenChannelMetadata | null {
    const channel = getChannel(channelOrId);
    if (!channel) return null;

    return {
        id: String(channel.id ?? ""),
        name: String(channel.name ?? "Unknown channel"),
        type: channel.type,
        typeLabel: getChannelTypeLabel(channel),
        topic: typeof channel.topic === "string" && channel.topic.length > 0
            ? channel.topic
            : "No topic.",
        createdAt: snowflakeTimestamp(channel.id),
        lastMessageAt: snowflakeTimestamp(channel.lastMessageId ?? channel.last_message_id),
        lastPinAt: normalizeTimestamp(channel.lastPinTimestamp ?? channel.last_pin_timestamp),
    };
}

export const hiddenChannelRuntime = {
    PermissionStore,
    ChannelStore,
    VIEW_CHANNEL,
};
