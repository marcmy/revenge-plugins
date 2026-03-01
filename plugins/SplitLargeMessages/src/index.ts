import { findAll, findByProps, findByStoreName } from "@vendetta/metro";
import { before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import settings from "./settings";

let unpatch: (() => void) | undefined;
const patchedLengthModules = new Map<Record<string, any>, Record<string, number>>();
const warningUnpatches: Array<() => void> = [];
const patchedWarningTargets = new WeakSet<object>();
let warningPatchInterval: ReturnType<typeof setInterval> | undefined;
storage.splitOnWords ??= false;

function patchMessageLengthConstants() {
    patchedLengthModules.clear();

    const modules = findAll((m) =>
        m && typeof m === "object" && Object.keys(m).some((key) => key.includes("MAX_MESSAGE_LENGTH"))
    ) as Array<Record<string, any>>;

    for (const mod of modules) {
        const previousValues: Record<string, number> = {};
        let touched = false;

        for (const key of Object.keys(mod)) {
            if (!key.includes("MAX_MESSAGE_LENGTH")) continue;
            if (typeof mod[key] !== "number") continue;

            previousValues[key] = mod[key];
            mod[key] = 2 ** 30;
            touched = true;
        }

        if (touched) patchedLengthModules.set(mod, previousValues);
    }
}

function restoreMessageLengthConstants() {
    for (const [mod, values] of patchedLengthModules) {
        for (const [key, value] of Object.entries(values)) {
            mod[key] = value;
        }
    }

    patchedLengthModules.clear();
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function getDraftText(channelId: string, DraftStore: any): string {
    if (!DraftStore?.getDraft) return "";

    try {
        const byType = DraftStore.getDraft(channelId, 0);
        if (typeof byType === "string") return byType;
    } catch { }

    try {
        const basic = DraftStore.getDraft(channelId);
        if (typeof basic === "string") return basic;
    } catch { }

    return "";
}

function intoChunks(content: string, maxChunkLength: number): string[] | false {
    const chunks = [] as string[];

    if (!storage.splitOnWords) {
        chunks.push(
            content.split("\n").reduce((currentChunk, paragraph) => {
                if (currentChunk.length + paragraph.length + 2 > maxChunkLength) {
                    chunks.push(currentChunk);
                    return paragraph + "\n";
                }
                if (!currentChunk) return paragraph + "\n";
                return currentChunk + paragraph + "\n";
            }, "")
        );
    }

    if (chunks.length && !chunks.some(chunk => chunk.length > maxChunkLength)) {
        return chunks.map(c => c.trim());
    }

    chunks.length = 0;
    chunks.push(
        content.split(" ").reduce((currentChunk, word) => {
            if (currentChunk.length + word.length + 2 > maxChunkLength) {
                chunks.push(currentChunk);
                return word + " ";
            }
            if (!currentChunk) return word + " ";
            return currentChunk + word + " ";
        }, "")
    );

    if (chunks.some(chunk => chunk.length > maxChunkLength)) return false;
    return chunks.map(c => c.trim());
}

export default {
    onLoad() {
        const ChannelStore = findByStoreName("ChannelStore");
        const SelectedChannelStore = findByStoreName("SelectedChannelStore");
        const UserStore = findByStoreName("UserStore");
        const MessageActions = findByProps("sendMessage", "editMessage");
        const DraftStore = findByProps("getDraft");
        const DraftManager = findByProps("clearDraft", "saveDraft");
        const UploadManager = findByProps("clearAll");

        const originalSendMessage = MessageActions.sendMessage.bind(MessageActions);
        const sendChunk = async (
            channelId: string,
            message: { [key: string]: any },
            content: string
        ) => {
            const chunkMessage = {
                invalidEmojis: message.invalidEmojis,
                validNonShortcutEmojis: message.validNonShortcutEmojis,
                tts: false,
                content,
            };

            if (typeof MessageActions._sendMessage === "function") {
                await MessageActions._sendMessage(channelId, chunkMessage, {});
                return;
            }

            await originalSendMessage(channelId, chunkMessage);
        };

        const getMaxLength = () => UserStore.getCurrentUser()?.premiumType === 2 ? 4000 : 2000;
        const sendChunksSequentially = async (channelId: string, chunks: string[]) => {
            for (const content of chunks) {
                await sendChunk(channelId, {}, content);
            }
        };
        const handleTooLongWarning = (props: any, orig: (props: any) => any) => {
            const channelId = props?.channel?.id
                ?? props?.channelId
                ?? SelectedChannelStore?.getChannelId?.();
            if (!channelId) return orig(props);

            const content = (typeof props?.content === "string" ? props.content : "")
                || (typeof props?.text === "string" ? props.text : "")
                || getDraftText(channelId, DraftStore);

            if (!content || content.length <= getMaxLength()) return orig(props);

            const chunks = intoChunks(content, getMaxLength());
            if (!chunks?.length) return orig(props);

            void sendChunksSequentially(channelId, chunks.filter(c => c.length > 0));

            try { DraftManager?.clearDraft?.(channelId, 0); } catch { }
            try { DraftManager?.clearDraft?.(channelId); } catch { }
            try { UploadManager?.clearAll?.(channelId, 0); } catch { }
            try { UploadManager?.clearAll?.(channelId); } catch { }

            return { shouldClear: false, shouldRefocus: true };
        };

        const patchWarningTargets = () => {
            const warningTargets = findAll(
                (m) => m && typeof m === "object" && typeof m.openWarningPopout === "function"
            ) as Array<Record<string, any>>;

            for (const target of warningTargets) {
                if (patchedWarningTargets.has(target)) continue;
                patchedWarningTargets.add(target);
                try {
                    warningUnpatches.push(
                        instead("openWarningPopout", target, ([props], orig) =>
                            handleTooLongWarning(props, orig as (props: any) => any)
                        )
                    );
                } catch { }
            }
        };

        patchMessageLengthConstants();
        patchWarningTargets();
        warningPatchInterval = setInterval(patchWarningTargets, 3000);

        unpatch?.();
        unpatch = before("sendMessage", MessageActions, args => {
            const [channelId, message] = args as [string, { content?: string; [key: string]: any }];
            const content = message?.content;

            if (!content || content.length <= getMaxLength()) return;

            const chunks = intoChunks(content, getMaxLength());
            if (!chunks) {
                message.content = "";
                showToast("Failed to split message", getAssetIDByName("Small"));
                return;
            }

            const nonEmptyChunks = chunks.filter(chunk => chunk.length > 0);
            if (!nonEmptyChunks.length) {
                message.content = "";
                showToast("Failed to split message", getAssetIDByName("Small"));
                return;
            }

            message.content = nonEmptyChunks.shift() ?? "";

            const channel = ChannelStore.getChannel(channelId);
            (async () => {
                for (const chunk of nonEmptyChunks) {
                    await sleep(Math.max((channel?.rateLimitPerUser ?? 0) * 1000, 1000));
                    await sendChunk(channelId, message, chunk);
                }
            })();
        });
    },
    onUnload: () => {
        unpatch?.();
        unpatch = undefined;
        if (warningPatchInterval) {
            clearInterval(warningPatchInterval);
            warningPatchInterval = undefined;
        }
        while (warningUnpatches.length) {
            try {
                warningUnpatches.pop()?.();
            } catch { }
        }

        restoreMessageLengthConstants();
    },
    settings,
};
