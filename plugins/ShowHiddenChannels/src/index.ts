import { storage } from "@vendetta/plugin";

import { patchChannelList } from "./patches/channelList";
import { patchFetching } from "./patches/fetching";
import { patchNavigation } from "./patches/navigation";
import { patchUnreads } from "./patches/unreads";
import { patchVoice } from "./patches/voice";
import settings from "./settings";

export type RegisterUnpatch = (unpatch: (() => void) | void) => void;
type PatchStarter = (registerUnpatch: RegisterUnpatch) => boolean;

const unpatches: Array<() => void> = [];

function registerUnpatch(unpatch: (() => void) | void) {
    if (typeof unpatch === "function") unpatches.push(unpatch);
}

function safeStartPatch(name: string, start: PatchStarter): boolean {
    try {
        return start(registerUnpatch);
    } catch (error) {
        try {
            console.error(`[ShowHiddenChannels] ${name} patch registration failed`, error);
        } catch { }
        return false;
    }
}

export default {
    onLoad() {
        storage.hideUnreads ??= true;
        storage.displayMode = "lock";
        storage.showInfoScreen ??= true;

        // Hidden rows are exposed only after every required safety guard is in
        // place. Unread suppression is cosmetic and therefore optional.
        const fetchSafe = safeStartPatch("fetching", patchFetching);
        const voiceSafe = safeStartPatch("voice", patchVoice);
        const navigationSafe = safeStartPatch("navigation", patchNavigation);
        safeStartPatch("unreads", patchUnreads);

        if (fetchSafe && voiceSafe && navigationSafe) {
            safeStartPatch("channel list", patchChannelList);
        } else {
            try {
                console.warn("[ShowHiddenChannels] required guard unavailable; hidden rows will not be revealed");
            } catch { }
        }
    },
    onUnload() {
        while (unpatches.length) {
            try {
                unpatches.pop()?.();
            } catch { }
        }
    },
    settings,
};
