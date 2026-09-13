import { findByProps } from "@vendetta/metro";
import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import { getChannel, isHiddenChannel } from "../core/hiddenChannel";
import { showHiddenChannelInfo } from "../ui/HiddenChannelScreen";

type RegisterUnpatch = (unpatch: (() => void) | void) => void;

function resolveNavigationTarget(args: any[]): any {
    return getChannel(args?.[1]) ??
        getChannel(args?.[0]?.channelId) ??
        getChannel(args?.[0]?.channel) ??
        getChannel(args?.[0]);
}

export function patchNavigation(registerUnpatch: RegisterUnpatch): boolean {
    const router = findByProps("transitionToGuild") as any;
    if (!router || typeof router.transitionToGuild !== "function") return false;

    registerUnpatch(instead("transitionToGuild", router, (args, orig) => {
        const channel = resolveNavigationTarget(args as any[]);
        if (!channel || !isHiddenChannel(channel)) return orig(...args);

        // Never enter Discord's normal chat/voice route for a hidden channel.
        // The information view is a local modal populated only from the
        // channel object Discord already supplied to the client.
        if (storage.showInfoScreen) showHiddenChannelInfo(channel);
        return undefined;
    }));

    return true;
}
