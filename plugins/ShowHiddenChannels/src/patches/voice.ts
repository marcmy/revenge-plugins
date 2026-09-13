import { findByProps } from "@vendetta/metro";
import { instead } from "@vendetta/patcher";

import { getChannel, isHiddenChannel, isVoiceLikeChannel } from "../core/hiddenChannel";

type RegisterUnpatch = (unpatch: (() => void) | void) => void;

export function patchVoice(registerUnpatch: RegisterUnpatch): void {
    const voiceActions = findByProps("selectVoiceChannel") as any;
    if (!voiceActions || typeof voiceActions.selectVoiceChannel !== "function") return;

    registerUnpatch(instead("selectVoiceChannel", voiceActions, (args, orig) => {
        const channel = getChannel(args?.[0]?.channelId) ?? getChannel(args?.[0]);
        if (channel && isHiddenChannel(channel) && isVoiceLikeChannel(channel)) {
            return undefined;
        }
        return orig(...args);
    }));
}
