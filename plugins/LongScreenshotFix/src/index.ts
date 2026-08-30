import { findByProps, findByStoreName } from "@vendetta/metro";
import { after, before, instead } from "@vendetta/patcher";

const TARGET_MESSAGES = 500;
const FETCH_BATCH_SIZE = 100;
const PRELOAD_START_DELAY_MS = 500;
const FETCH_SETTLE_DELAY_MS = 150;
const MAX_STALLED_FETCHES = 2;

const unpatches: Array<() => void> = [];
let preloadTimer: ReturnType<typeof setTimeout> | undefined;
let preloadGeneration = 0;
let internalFetchDepth = 0;
let unloaded = false;

let MessageActions: any;
let MessageStore: any;
let SelectedChannelStore: any;
let ChannelMessages: any;

function log(...args: any[]) {
    try {
        console.log("[LongScreenshotFix]", ...args);
    } catch {}
}

function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function safeRegisterPatch(register: () => (() => void) | void) {
    try {
        const unpatch = register();
        if (typeof unpatch === "function") unpatches.push(unpatch);
    } catch (error) {
        console.error("[LongScreenshotFix] patch registration failed", error);
    }
}

function resolveModules() {
    try {
        MessageActions ??= findByProps("fetchMessages", "jumpToMessage");
    } catch {}

    try {
        MessageStore ??= findByStoreName("MessageStore") ?? findByProps("getMessage", "getMessages");
    } catch {}

    try {
        SelectedChannelStore ??=
            findByStoreName("SelectedChannelStore") ??
            findByProps("getChannelId", "getLastSelectedChannelId");
    } catch {}

    try {
        ChannelMessages ??= findByProps("_channelMessages", "getOrCreate", "commit") ?? findByProps("_channelMessages");
    } catch {}
}

function getSelectedChannelId(): string | undefined {
    try {
        return SelectedChannelStore?.getChannelId?.();
    } catch {
        return undefined;
    }
}

function getChannelMessages(channelId: string): any {
    try {
        const fromStore = MessageStore?.getMessages?.(channelId);
        if (fromStore) return fromStore;
    } catch {}

    try {
        return ChannelMessages?.get?.(channelId) ?? ChannelMessages?._channelMessages?.[channelId];
    } catch {
        return undefined;
    }
}

function getLoadedCount(messages: any): number {
    const length = Number(messages?.length);
    if (Number.isFinite(length) && length >= 0) return length;

    try {
        const array = messages?.toArray?.();
        if (Array.isArray(array)) return array.length;
    } catch {}

    return Array.isArray(messages?._array) ? messages._array.length : 0;
}

function getOldestMessageId(messages: any): string | undefined {
    try {
        const first = messages?.first?.();
        if (first?.id) return first.id;
    } catch {}

    try {
        const array = messages?.toArray?.();
        if (Array.isArray(array) && array[0]?.id) return array[0].id;
    } catch {}

    return messages?._array?.[0]?.id;
}

async function waitForFetchToSettle(channelId: string, previousCount: number) {
    for (let attempt = 0; attempt < 20 && !unloaded; attempt++) {
        await delay(100);
        const messages = getChannelMessages(channelId);
        const count = getLoadedCount(messages);
        if (!messages?.loadingMore && count !== previousCount) return;
        if (!messages?.loadingMore && attempt >= 4) return;
    }
}

async function preloadChannel(channelId: string, generation: number) {
    resolveModules();
    if (!MessageActions?.fetchMessages || !channelId) return;

    let stalledFetches = 0;
    let fetches = 0;

    while (!unloaded && generation === preloadGeneration) {
        const selectedChannelId = getSelectedChannelId();
        if (selectedChannelId && selectedChannelId !== channelId) return;

        const messages = getChannelMessages(channelId);
        if (!messages) return;

        const loadedCount = getLoadedCount(messages);
        if (loadedCount >= TARGET_MESSAGES || messages.hasMoreBefore === false) {
            if (fetches > 0) {
                log(`preloaded ${loadedCount} messages in ${channelId} with ${fetches} extra fetch(es)`);
            }
            return;
        }

        if (messages.loadingMore) {
            await delay(FETCH_SETTLE_DELAY_MS);
            continue;
        }

        const oldestMessageId = getOldestMessageId(messages);
        if (!oldestMessageId) return;

        const limit = Math.max(1, Math.min(FETCH_BATCH_SIZE, TARGET_MESSAGES - loadedCount));

        try {
            internalFetchDepth++;
            const result = MessageActions.fetchMessages({
                channelId,
                before: oldestMessageId,
                limit,
            });

            if (result && typeof result.then === "function") {
                await result;
            }
        } catch (error) {
            console.error("[LongScreenshotFix] history preload failed", error);
            return;
        } finally {
            internalFetchDepth--;
        }

        fetches++;
        await waitForFetchToSettle(channelId, loadedCount);

        const nextMessages = getChannelMessages(channelId);
        const nextCount = getLoadedCount(nextMessages);
        if (nextCount <= loadedCount) {
            stalledFetches++;
            if (stalledFetches >= MAX_STALLED_FETCHES) {
                log(`stopped preloading ${channelId}: no additional messages were retained`);
                return;
            }
        } else {
            stalledFetches = 0;
        }

        await delay(FETCH_SETTLE_DELAY_MS);
    }
}

function schedulePreload(channelId?: string, delayMs = PRELOAD_START_DELAY_MS) {
    resolveModules();
    const targetChannelId = channelId ?? getSelectedChannelId();
    if (!targetChannelId || unloaded) return;

    preloadGeneration++;
    const generation = preloadGeneration;

    if (preloadTimer) clearTimeout(preloadTimer);
    preloadTimer = setTimeout(() => {
        preloadTimer = undefined;
        void preloadChannel(targetChannelId, generation);
    }, delayMs);
}

function patchMessageRetention() {
    resolveModules();
    const prototype = ChannelMessages?.prototype;
    if (!prototype) {
        log("ChannelMessages prototype was not available; retention patch skipped");
        return;
    }

    if (typeof prototype.truncate === "function") {
        safeRegisterPatch(() =>
            instead("truncate", prototype, function (args, orig) {
                const length = Number((this as any)?.length);
                if (!Number.isFinite(length)) return orig(...args);
                if (length <= TARGET_MESSAGES) return this;

                const [truncateBottom, truncateTop] = args as [boolean | undefined, boolean | undefined];
                if (truncateBottom && typeof (this as any).truncateBottom === "function") {
                    return (this as any).truncateBottom(TARGET_MESSAGES);
                }
                if (truncateTop && typeof (this as any).truncateTop === "function") {
                    return (this as any).truncateTop(TARGET_MESSAGES);
                }

                return this;
            })
        );
    }

    if (typeof prototype.truncateTop === "function") {
        safeRegisterPatch(() =>
            before("truncateTop", prototype, (args) => {
                const requestedLimit = Number(args[0]);
                if (args[1] === false && Number.isFinite(requestedLimit) && requestedLimit < TARGET_MESSAGES) {
                    args[0] = TARGET_MESSAGES;
                }
            })
        );
    }

    if (typeof prototype.truncateBottom === "function") {
        safeRegisterPatch(() =>
            before("truncateBottom", prototype, (args) => {
                const requestedLimit = Number(args[0]);
                if (args[1] === false && Number.isFinite(requestedLimit) && requestedLimit < TARGET_MESSAGES) {
                    args[0] = TARGET_MESSAGES;
                }
            })
        );
    }
}

function patchHistoryFetches() {
    resolveModules();
    if (!MessageActions?.fetchMessages) {
        log("MessageActions.fetchMessages was not available; auto-preload patch skipped");
        return;
    }

    safeRegisterPatch(() =>
        after("fetchMessages", MessageActions, (args, result) => {
            if (internalFetchDepth > 0 || unloaded) return;

            const channelId = args?.[0]?.channelId;
            if (!channelId) return;

            const selectedChannelId = getSelectedChannelId();
            if (selectedChannelId && selectedChannelId !== channelId) return;

            const queue = () => schedulePreload(channelId);
            if (result && typeof result.then === "function") {
                Promise.resolve(result).then(queue, queue);
            } else {
                queue();
            }
        })
    );
}

export default {
    onLoad() {
        unloaded = false;
        resolveModules();
        patchMessageRetention();
        patchHistoryFetches();
        schedulePreload(undefined, 750);
        log(`enabled; retaining and preloading up to ${TARGET_MESSAGES} messages per active channel`);
    },

    onUnload() {
        unloaded = true;
        preloadGeneration++;

        if (preloadTimer) {
            clearTimeout(preloadTimer);
            preloadTimer = undefined;
        }

        while (unpatches.length) {
            try {
                unpatches.pop()?.();
            } catch {}
        }
    },
};
