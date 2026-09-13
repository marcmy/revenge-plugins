import { findByProps, findByStoreName } from "@vendetta/metro";
import { after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import { isHiddenChannel } from "../core/hiddenChannel";

type RegisterUnpatch = (unpatch: (() => void) | void) => void;

function shouldSuppress(channelId: any): boolean {
    return !!storage.hideUnreads && isHiddenChannel(channelId);
}

function patchBooleanMethod(target: any, method: string, registerUnpatch: RegisterUnpatch) {
    if (typeof target?.[method] !== "function") return false;
    registerUnpatch(after(method, target, (args, result) => {
        if (shouldSuppress(args?.[0])) return false;
        return result;
    }));
    return true;
}

function patchCountMethod(target: any, method: string, registerUnpatch: RegisterUnpatch) {
    if (typeof target?.[method] !== "function") return false;
    registerUnpatch(after(method, target, (args, result) => {
        if (shouldSuppress(args?.[0])) return 0;
        return result;
    }));
    return true;
}

export function patchUnreads(registerUnpatch: RegisterUnpatch): boolean {
    const readStateStore = (
        findByStoreName("ReadStateStore") ??
        findByProps("hasUnread", "lastMessageId") ??
        findByProps("getUnreadCount")
    ) as any;

    if (!readStateStore) return false;

    let patched = false;
    patched = patchBooleanMethod(readStateStore, "hasUnread", registerUnpatch) || patched;
    patched = patchCountMethod(readStateStore, "getUnreadCount", registerUnpatch) || patched;
    patched = patchCountMethod(readStateStore, "getMentionCount", registerUnpatch) || patched;
    return patched;
}
