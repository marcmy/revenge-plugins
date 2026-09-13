import { storage } from "@vendetta/plugin";

import { patchChannelList } from "./patches/channelList";
import settings from "./settings";

export type RegisterUnpatch = (unpatch: (() => void) | void) => void;

const unpatches: Array<() => void> = [];

function registerUnpatch(unpatch: (() => void) | void) {
    if (typeof unpatch === "function") unpatches.push(unpatch);
}

function safeStartPatch(start: (registerUnpatch: RegisterUnpatch) => void) {
    try {
        start(registerUnpatch);
    } catch { }
}

export default {
    onLoad() {
        storage.hideUnreads ??= true;
        storage.displayMode ??= "lock";
        storage.showInfoScreen ??= true;

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
