import { findByProps } from "@vendetta/metro";
import { instead } from "@vendetta/patcher";

import { getChannel, hiddenChannelRuntime } from "../core/hiddenChannel";

type RegisterUnpatch = (unpatch: (() => void) | void) => void;

let channelListBuildDepth = 0;

function isGuildPermissionTarget(channelOrId: any): boolean {
    const channel = getChannel(channelOrId) ?? channelOrId;
    return !!(channel && typeof channel === "object" && (channel.guild_id ?? channel.guildId));
}

export function patchChannelList(registerUnpatch: RegisterUnpatch): boolean {
    const channelListStore = findByProps(
        "getGuild",
        "getGuildWithoutChangingGuildActionRows",
        "recentsChannelCount"
    ) as any;

    const { PermissionStore, VIEW_CHANNEL } = hiddenChannelRuntime;

    if (!channelListStore || typeof channelListStore.getGuild !== "function") return false;
    if (!PermissionStore || typeof PermissionStore.can !== "function" || VIEW_CHANNEL == null) return false;

    // Keep the permission relaxation strictly inside synchronous guild-list model
    // construction. All other Discord permission checks retain their real result.
    registerUnpatch(instead("can", PermissionStore, (args, orig) => {
        const [permission, channel] = args as [any, any];
        if (
            channelListBuildDepth > 0 &&
            permission === VIEW_CHANNEL &&
            isGuildPermissionTarget(channel)
        ) {
            return true;
        }
        return orig(...args);
    }));

    registerUnpatch(instead("getGuild", channelListStore, (args, orig) => {
        channelListBuildDepth++;
        try {
            return orig(...args);
        } finally {
            channelListBuildDepth--;
        }
    }));

    return true;
}
