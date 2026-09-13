import { storage } from "@vendetta/plugin";

import { patchChannelList } from "./patches/channelList";
import { patchFetching } from "./patches/fetching";
import { patchNavigation } from "./patches/navigation";
import { patchUnreads } from "./patches/unreads";
import { patchVoice } from "./patches/voice";
import settings from "./settings";

export type RegisterUnpatch = (unpatch: (() => void) | void) => void;

const unpatches: Array<() => void> = [];

function registerUnpatch(unpatch: (() => void) | void) {
    if (typeof unpatch === "function") unpatches.push(unpatch);
}

function safeStartPatch(start: (registerUnpatch: RegisterUnpatch) => void) {
    try {
        start(registerUnpatch);
    } catch (error) {
        try {
            console.error("[ShowHiddenChannels] patch registration failed", error);
        } catch { }
    }
}

export default {
    onLoad() {
        storage.hideUnreads ??= true;
        storage.displayMode ??= "lock";
        storage.showInfoScreen ??= true;

        // Install safety guards before making hidden rows visible.
        safeStartPatch(patchFetching);
        safeStartPatch(patchVoice);
        safeStartPatch(patchUnreads);
        safeStartPatch(patchNavigation);
        safeStartPatch(patchChannelList);
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
