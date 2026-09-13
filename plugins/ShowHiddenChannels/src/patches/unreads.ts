import { findByProps, findByStoreName } from "@vendetta/metro";
import { after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import { isHiddenChannel } from "../core/hiddenChannel";

type RegisterUnpatch = (unpatch: (() => void) | void) => void;

function shouldSuppress(channelId: any): boolean {
    return !!storage.hideUnreads && isHiddenChannel(channelId);
}

function patchBooleanMethod(target: any, method: string, registerUnpatch: RegisterUnpatch) {
    if (typeof target?.[method] !== "function") return;
    registerUnpatch(after(method, target, (args, result) => {
        if (shouldSuppress(args?.[0])) return false;
        return result;
    }));
}

function patchCountMethod(target: any, method: string, registerUnpatch: RegisterUnpatch) {
    if (typeof target?.[method] !== "function") return;
    registerUnpatch(after(method, target, (args, result) => {
        if (shouldSuppress(args?.[0])) return 0;
        return result;
    }));
}

export function patchUnreads(registerUnpatch: RegisterUnpatch): void {
    const readStateStore = (
        findByStoreName("ReadStateStore") ??
        findByProps("hasUnread", "lastMessageId") ??
        findByProps("getUnreadCount")
    ) as any;

    if (!readStateStore) return;

    patchBooleanMethod(readStateStore, "hasUnread", registerUnpatch);
    patchCountMethod(readStateStore, "getUnreadCount", registerUnpatch);
    patchCountMethod(readStateStore, "getMentionCount", registerUnpatch);
}
