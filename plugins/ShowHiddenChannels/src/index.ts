import { storage } from "@vendetta/plugin";

import settings from "./settings";

export type RegisterUnpatch = (unpatch: (() => void) | void) => void;

const unpatches: Array<() => void> = [];

function registerUnpatch(unpatch: (() => void) | void) {
    if (typeof unpatch === "function") unpatches.push(unpatch);
}

export function safeRegisterPatch(register: () => (() => void) | void) {
    try {
        registerUnpatch(register());
    } catch { }
}

export default {
    onLoad() {
        storage.hideUnreads ??= true;
        storage.displayMode ??= "lock";
        storage.showInfoScreen ??= true;
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
