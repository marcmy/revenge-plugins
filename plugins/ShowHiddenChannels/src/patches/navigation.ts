import { findByName, findByProps } from "@vendetta/metro";
import { React } from "@vendetta/metro/common";
import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import { getChannel, isHiddenChannel, isTextLikeChannel, isVoiceLikeChannel } from "../core/hiddenChannel";
import HiddenChannelScreen from "../ui/HiddenChannelScreen";

type RegisterUnpatch = (unpatch: (() => void) | void) => void;

function resolveNavigationTarget(args: any[]): any {
    return getChannel(args?.[1]) ??
        getChannel(args?.[0]?.channelId) ??
        getChannel(args?.[0]?.channel) ??
        getChannel(args?.[0]);
}

export function patchNavigation(registerUnpatch: RegisterUnpatch): void {
    const messagesWrapper = findByName("MessagesWrapperConnected", false) as any;
    const router = findByProps("transitionToGuild") as any;

    const canRenderInfo = !!messagesWrapper && typeof messagesWrapper.default === "function";

    if (canRenderInfo) {
        registerUnpatch(instead("default", messagesWrapper, (args, orig) => {
            const channel = getChannel(args?.[0]?.channel);
            if (channel && isHiddenChannel(channel)) {
                if (!storage.showInfoScreen) return null;
                return React.createElement(HiddenChannelScreen, { channel });
            }
            return orig(...args);
        }));
    }

    if (router && typeof router.transitionToGuild === "function") {
        registerUnpatch(instead("transitionToGuild", router, (args, orig) => {
            const channel = resolveNavigationTarget(args as any[]);
            if (!channel || !isHiddenChannel(channel)) return orig(...args);

            // Entering a hidden channel is only useful when the read-only view
            // can replace Discord's normal messages surface. Otherwise consume
            // the navigation rather than opening ordinary chat.
            if (
                canRenderInfo &&
                storage.showInfoScreen &&
                (isTextLikeChannel(channel) || isVoiceLikeChannel(channel))
            ) {
                return orig(...args);
            }

            return undefined;
        }));
    }
}
