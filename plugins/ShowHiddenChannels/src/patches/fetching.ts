import { findByProps } from "@vendetta/metro";
import { instead } from "@vendetta/patcher";

import { getChannel, isHiddenChannel } from "../core/hiddenChannel";

type RegisterUnpatch = (unpatch: (() => void) | void) => void;

function resolveFetchTarget(arg: any): any {
    return getChannel(arg?.channelId) ??
        getChannel(arg?.channel_id) ??
        getChannel(arg?.channel) ??
        getChannel(arg);
}

export function patchFetching(registerUnpatch: RegisterUnpatch): boolean {
    const messageActions = (
        findByProps("fetchMessages", "jumpToMessage") ??
        findByProps("stores", "fetchMessages")
    ) as any;

    if (!messageActions || typeof messageActions.fetchMessages !== "function") return false;

    registerUnpatch(instead("fetchMessages", messageActions, (args, orig) => {
        const channel = resolveFetchTarget(args?.[0]);
        if (channel && isHiddenChannel(channel)) return undefined;
        return orig(...args);
    }));

    return true;
}
