import { findByProps, findByStoreName } from "@vendetta/metro";
import { constants } from "@vendetta/metro/common";
import { after, before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showConfirmationAlert } from "@vendetta/ui/alerts";

import settings from "./settings";

const unpatches: Array<() => void> = [];
const seenGuildChannels = new Set<any>();

let ChannelListStore: any;
let ChannelStore: any;
let PermissionStore: any;
let ReadStateStore: any;
let ChannelUtils: any;
let PrivateChannelHidingExperiment: any;
let ChannelActions: any;
let ChannelTransitions: any;
let VoiceModalUtils: any;
let StageChannelActions: any;
let ViewChannelPermission: any;
let originalPermissionCan: ((permission: any, channel: any) => boolean) | undefined;

// PermissionStore.can stays fully real outside the tiny synchronous window in
// which Discord recomputes one hidden channel's channel-list state.
let viewPermissionOverrideChannelId: string | undefined;

function log(...args: any[]) {
    try {
        console.log("[ShowHiddenChannels]", ...args);
    } catch {}
}

function safeRegisterPatch(register: () => (() => void) | void) {
    try {
        const unpatch = register();
        if (typeof unpatch === "function") unpatches.push(unpatch);
    } catch (error) {
        console.error("[ShowHiddenChannels] patch registration failed", error);
    }
}

function resolveModules() {
    try {
        ChannelListStore ??= findByProps(
            "getGuild",
            "getGuildWithoutChangingGuildActionRows",
            "recentsChannelCount"
        );
    } catch {}

    try {
        ChannelStore ??=
            findByStoreName("ChannelStore") ??
            findByProps("getChannel", "getMutableGuildChannelsForGuild");
    } catch {}

    try {
        PermissionStore ??=
            findByStoreName("PermissionStore") ??
            findByProps("can", "getChannelPermissions");
        if (!originalPermissionCan && typeof PermissionStore?.can === "function") {
            originalPermissionCan = PermissionStore.can.bind(PermissionStore);
        }
    } catch {}

    try {
        ReadStateStore ??=
            findByStoreName("ReadStateStore") ??
            findByProps("hasUnread", "getMentionCount", "hasUnreadPins");
    } catch {}

    try {
        ChannelUtils ??= findByProps("getChannelIcon", "getChannelIconComponent");
    } catch {}

    try {
        PrivateChannelHidingExperiment ??= findByProps(
            "getCachedPrivateChannelObfuscation",
            "isChannelMetadataObfuscationEnabled",
            "useIsChannelMetadataObfuscationEnabled",
            "isChannelMetadataIntegrityCheckEnabled"
        );
    } catch {}

    try {
        ChannelActions ??= findByProps("preload", "fetchChannelStoreListing");
    } catch {}

    try {
        ChannelTransitions ??= findByProps(
            "transitionToChannel",
            "transitionToThread",
            "transitionToMessage"
        );
    } catch {}

    try {
        VoiceModalUtils ??= findByProps("openGuildVoiceModal", "navigateToVoiceChannel");
    } catch {}

    try {
        StageChannelActions ??= findByProps("openStageChannel", "openStageChannelSettings");
    } catch {}

    try {
        ViewChannelPermission ??=
            constants?.Permissions?.VIEW_CHANNEL ??
            findByProps("Permissions")?.Permissions?.VIEW_CHANNEL;
    } catch {}
}

function permissionsEqual(left: any, right: any): boolean {
    if (left === right) return true;
    if (left == null || right == null) return false;

    try {
        return left.toString() === right.toString();
    } catch {
        return false;
    }
}

function canViewChannel(channel: any): boolean {
    if (!channel || !originalPermissionCan || ViewChannelPermission == null) return true;

    try {
        return !!originalPermissionCan(ViewChannelPermission, channel);
    } catch {
        return true;
    }
}

function isHiddenChannel(channel: any): boolean {
    if (!channel?.guild_id) return false;

    try {
        if (channel.isPrivate?.() || channel.isCategory?.()) return false;
    } catch {}

    return !canViewChannel(channel);
}

function isHiddenChannelId(channelId: any): boolean {
    if (typeof channelId !== "string" || !ChannelStore?.getChannel) return false;

    try {
        return isHiddenChannel(ChannelStore.getChannel(channelId));
    } catch {
        return false;
    }
}

function getChannelTypeName(channel: any): string {
    try {
        if (channel.isGuildStageVoice?.()) return "stage";
        if (channel.isGuildVoice?.()) return "voice";
        if (channel.isForumChannel?.()) return "forum";
        if (channel.isAnnouncementChannel?.()) return "announcement";
    } catch {}
    return "text";
}

function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
    if (seconds % 3600 === 0) {
        const hours = seconds / 3600;
        return `${hours} hour${hours === 1 ? "" : "s"}`;
    }
    if (seconds % 60 === 0) {
        const minutes = seconds / 60;
        return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
    return `${seconds} seconds`;
}

function showHiddenChannelInfo(channel: any) {
    if (!channel) return;

    const type = getChannelTypeName(channel);
    const lines = [
        `This is a hidden ${type} channel.`,
        type === "voice" || type === "stage"
            ? "You do not have permission to access this channel."
            : `You do not have permission to view its ${type === "forum" ? "posts" : "messages"}.`,
    ];

    const topic = typeof channel.topic === "string" ? channel.topic.trim() : "";
    if (topic) {
        const clippedTopic = topic.length > 600 ? `${topic.slice(0, 597)}...` : topic;
        lines.push("", `${type === "forum" ? "Guidelines" : "Topic"}: ${clippedTopic}`);
    }

    const slowmode = Number(channel.rateLimitPerUser ?? 0);
    if (slowmode > 0) lines.push(`Slowmode: ${formatDuration(slowmode)}`);

    const threadSlowmode = Number(channel.defaultThreadRateLimitPerUser ?? 0);
    if (threadSlowmode > 0) {
        lines.push(`Default thread slowmode: ${formatDuration(threadSlowmode)}`);
    }

    const bitrate = Number(channel.bitrate ?? 0);
    if ((type === "voice" || type === "stage") && bitrate > 0) {
        lines.push(`Bitrate: ${Math.round(bitrate / 1000)} kbps`);
    }

    if ((type === "voice" || type === "stage") && "rtcRegion" in channel) {
        lines.push(`Region: ${channel.rtcRegion || "Automatic"}`);
    }

    try {
        if (channel.isNSFW?.()) lines.push("NSFW: Yes");
    } catch {}

    showConfirmationAlert({
        title: `${type === "text" || type === "announcement" || type === "forum" ? "#" : ""}${channel.name ?? "Hidden channel"}`,
        content: lines.join("\n"),
        confirmText: "Close",
        onConfirm: () => {},
    });
}

function withViewPermission<T>(channel: any, callback: () => T): T {
    const previousOverride = viewPermissionOverrideChannelId;
    viewPermissionOverrideChannelId = channel?.id;

    try {
        return callback();
    } finally {
        viewPermissionOverrideChannelId = previousOverride;
    }
}

function updateChannelListItem(item: any, initializationData: any, reveal: boolean): boolean {
    const channel = item?.record;
    if (!channel || !isHiddenChannel(channel)) return false;

    let changed = false;

    try {
        if (typeof item.updateChannel === "function") {
            changed = reveal
                ? !!withViewPermission(channel, () => item.updateChannel(channel, initializationData))
                : !!item.updateChannel(channel, initializationData);
        } else if (typeof item.computeState === "function") {
            const state = reveal
                ? withViewPermission(channel, () => item.computeState(initializationData))
                : item.computeState(initializationData);

            if (state) {
                const previousRenderLevel = item.renderLevel;
                const previousThreadIds = item.threadIds;

                item.renderLevel = state.renderLevel;
                item.threadIds = state.threadIds ?? [];
                item.threadCount = item.threadIds?.length ?? 0;

                changed =
                    previousRenderLevel !== item.renderLevel ||
                    previousThreadIds !== item.threadIds;
            }
        }

        if (reveal && item.renderLevel > 1 && typeof item.updateSubtitle === "function") {
            changed = !!item.updateSubtitle() || changed;
        }
    } catch (error) {
        console.error("[ShowHiddenChannels] failed to recompute channel", channel?.id, error);
    }

    return changed;
}

function refreshGuildChannels(guildChannels: any, reveal: boolean): boolean {
    if (!guildChannels) return false;

    let categories: any[] = [];
    try {
        const resolved = guildChannels.getSortedCategories?.();
        if (Array.isArray(resolved)) categories = resolved;
    } catch {}

    if (!categories.length) return false;

    let initializationData: any;
    try {
        initializationData = guildChannels.initializationData;
    } catch {
        return false;
    }

    let changed = false;
    const visitedCategories = new Set<any>();

    for (const category of categories) {
        if (!category || visitedCategories.has(category)) continue;
        visitedCategories.add(category);

        let categoryChanged = false;
        const channels = category.channels;
        if (!channels || typeof channels !== "object") continue;

        for (const item of Object.values(channels)) {
            categoryChanged = updateChannelListItem(item, initializationData, reveal) || categoryChanged;
        }

        if (categoryChanged) {
            try {
                category.invalidate?.();
            } catch {}
            changed = true;
        }
    }

    if (changed) {
        try {
            guildChannels.invalidate?.();
        } catch {}

        if (reveal) seenGuildChannels.add(guildChannels);
    }

    return changed;
}

function patchPermissionStore() {
    if (!PermissionStore?.can || ViewChannelPermission == null) return;

    safeRegisterPatch(() =>
        instead("can", PermissionStore, (args, orig) => {
            const [permission, channel] = args;
            if (
                viewPermissionOverrideChannelId != null &&
                channel?.id === viewPermissionOverrideChannelId &&
                permissionsEqual(permission, ViewChannelPermission)
            ) {
                return true;
            }

            return orig(...args);
        })
    );
}

function patchChannelListStore() {
    if (!ChannelListStore) return;

    const patchResult = (method: string) => {
        if (typeof ChannelListStore[method] !== "function") return;

        safeRegisterPatch(() =>
            after(method, ChannelListStore, (_args, result) => {
                const guildChannels = result?.guildChannels;
                if (!guildChannels) return;

                if (refreshGuildChannels(guildChannels, true) && result) {
                    try {
                        result.guildChannelsVersion = guildChannels.version;
                    } catch {}
                }
            })
        );
    };

    patchResult("getGuild");
    patchResult("getGuildWithoutChangingGuildActionRows");
}

function patchReadStateStore() {
    if (!ReadStateStore) return;

    const patchBoolean = (method: string) => {
        if (typeof ReadStateStore[method] !== "function") return;

        safeRegisterPatch(() =>
            after(method, ReadStateStore, (args, result) => {
                if (storage.hideUnreads !== false && isHiddenChannelId(args?.[0])) return false;
                return result;
            })
        );
    };

    const patchNumber = (method: string) => {
        if (typeof ReadStateStore[method] !== "function") return;

        safeRegisterPatch(() =>
            after(method, ReadStateStore, (args, result) => {
                if (storage.hideUnreads !== false && isHiddenChannelId(args?.[0])) return 0;
                return result;
            })
        );
    };

    patchBoolean("hasUnread");
    patchBoolean("hasUnreadOrMentions");
    patchBoolean("hasTrackedUnread");
    patchBoolean("hasUnreadPins");
    patchNumber("getMentionCount");
}

function patchChannelIcons() {
    if (!ChannelUtils) return;

    for (const method of ["getChannelIcon", "getChannelIconComponent"]) {
        if (typeof ChannelUtils[method] !== "function") continue;

        safeRegisterPatch(() =>
            before(method, ChannelUtils, (args) => {
                if (!isHiddenChannel(args?.[0])) return;

                const options = args?.[1];
                args[1] = options && typeof options === "object"
                    ? { ...options, locked: true }
                    : { locked: true };
            })
        );
    }
}

function patchPrivateChannelHidingExperiment() {
    if (!PrivateChannelHidingExperiment) {
        log("private-channel-hiding experiment module was not available");
        return;
    }

    for (const method of [
        "getCachedPrivateChannelObfuscation",
        "isChannelMetadataObfuscationEnabled",
        "useIsChannelMetadataObfuscationEnabled",
        "isChannelMetadataIntegrityCheckEnabled",
    ]) {
        if (typeof PrivateChannelHidingExperiment[method] !== "function") continue;

        safeRegisterPatch(() =>
            instead(method, PrivateChannelHidingExperiment, () => false)
        );
    }
}

function patchHiddenChannelNavigation() {
    if (ChannelActions?.preload) {
        safeRegisterPatch(() =>
            instead("preload", ChannelActions, (args, orig) => {
                const channelId = args?.[1];
                if (isHiddenChannelId(channelId)) return;
                return orig(...args);
            })
        );
    }

    if (ChannelTransitions?.transitionToChannel) {
        safeRegisterPatch(() =>
            instead("transitionToChannel", ChannelTransitions, (args, orig) => {
                const channelId = args?.[0];
                if (!isHiddenChannelId(channelId)) return orig(...args);

                showHiddenChannelInfo(ChannelStore?.getChannel?.(channelId));
            })
        );
    }

    const patchVoiceNavigation = (module: any, method: string) => {
        if (typeof module?.[method] !== "function") return;

        safeRegisterPatch(() =>
            instead(method, module, (args, orig) => {
                const channel = args?.[0];
                if (!isHiddenChannel(channel)) return orig(...args);

                showHiddenChannelInfo(channel);
            })
        );
    };

    patchVoiceNavigation(VoiceModalUtils, "openGuildVoiceModal");
    patchVoiceNavigation(VoiceModalUtils, "navigateToVoiceChannel");
    patchVoiceNavigation(StageChannelActions, "openStageChannel");
}

function restoreSeenGuildChannels() {
    for (const guildChannels of seenGuildChannels) {
        try {
            refreshGuildChannels(guildChannels, false);
        } catch {}
    }
    seenGuildChannels.clear();
}

export default {
    onLoad() {
        storage.hideUnreads ??= true;
        resolveModules();
        patchPrivateChannelHidingExperiment();

        if (!ChannelListStore || !ChannelStore || !PermissionStore || ViewChannelPermission == null) {
            log("required Discord modules were not available; plugin was not patched");
            return;
        }

        patchPermissionStore();
        patchChannelListStore();
        patchReadStateStore();
        patchChannelIcons();
        patchHiddenChannelNavigation();

        try {
            ChannelListStore.emitChange?.();
        } catch {}

        log("enabled");
    },

    onUnload() {
        // With no override active, recomputing restores Discord's real
        // CannotShow state before the patches are removed.
        viewPermissionOverrideChannelId = undefined;
        restoreSeenGuildChannels();

        while (unpatches.length) {
            try {
                unpatches.pop()?.();
            } catch {}
        }

        try {
            ChannelListStore?.emitChange?.();
        } catch {}
    },

    settings,
};
