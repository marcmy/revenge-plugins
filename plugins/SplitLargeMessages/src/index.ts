import { findAll, findByProps, findByStoreName } from "@vendetta/metro";
import { i18n } from "@vendetta/metro/common";
import { before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import settings from "./settings";

let unpatch: (() => void) | undefined;
const patchedLengthModules = new Map<Record<string, any>, Record<string, number>>();
const warningUnpatches: Array<() => void> = [];
const patchedWarningTargets = new Set<object>();
const patchedPopupTargets = new Set<object>();
const patchedUploadTargets = new Set<object>();
const patchedComposerTargets = new Set<object>();
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

function collectStringsDeep(value: any, out: string[] = [], depth = 0): string[] {
    if (value == null || depth > 6) return out;
    if (typeof value === "string") {
        out.push(value);
        return out;
    }
    if (typeof value === "function") {
        try {
            out.push(Function.prototype.toString.call(value));
        } catch { }
        return out;
    }

    if (Array.isArray(value)) {
        for (const item of value) collectStringsDeep(item, out, depth + 1);
        return out;
    }

    if (typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
            if (k === "onConfirm" || k === "onCancel" || k === "render" || k === "children") continue;
            collectStringsDeep(v, out, depth + 1);
        }
    }

    return out;
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

function isAutoTextFile(file: any): boolean {
    if (!file) return false;
    const name = String(file.name ?? "");
    const type = String(file.type ?? "");
    if (name !== "message.txt") return false;
    return !type || type === "text/plain";
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
        const UploadHandler = findByProps("promptToUpload");
        const Popup = findByProps("show", "openLazy");
        const ModalManager = findByProps("openModal", "openModalLazy");

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
        const clearDraftAndUploads = (channelId: string) => {
            try { DraftManager?.clearDraft?.(channelId, 0); } catch { }
            try { DraftManager?.clearDraft?.(channelId); } catch { }
            try { UploadManager?.clearAll?.(channelId, 0); } catch { }
            try { UploadManager?.clearAll?.(channelId); } catch { }
        };
        const splitAndSend = (channelId: string, rawContent?: string) => {
            const content = (typeof rawContent === "string" ? rawContent : "") || getDraftText(channelId, DraftStore);
            if (!content || content.length <= getMaxLength()) return false;

            const chunks = intoChunks(content, getMaxLength());
            if (!chunks?.length) return false;

            const nonEmptyChunks = chunks.filter(c => c.length > 0);
            if (!nonEmptyChunks.length) return false;

            console.log("[SplitLargeMessages] splitting long message", {
                channelId,
                length: content.length,
                maxLength: getMaxLength(),
                chunks: nonEmptyChunks.length,
            });
            void sendChunksSequentially(channelId, nonEmptyChunks);
            clearDraftAndUploads(channelId);
            return true;
        };
        const handleTooLongWarning = (props: any, orig: (props: any) => any) => {
            const channelId = props?.channel?.id
                ?? props?.channelId
                ?? SelectedChannelStore?.getChannelId?.();
            if (!channelId) return orig(props);

            const content = (typeof props?.content === "string" ? props.content : "")
                || (typeof props?.text === "string" ? props.text : "")
                || getDraftText(channelId, DraftStore);

            if (!splitAndSend(channelId, content)) return orig(props);

            return { shouldClear: false, shouldRefocus: true };
        };
        const handleTooLongPopup = (modalArgs: any[], orig: (...args: any[]) => any) => {
            const modalText = collectStringsDeep(modalArgs)
                .join(" ")
                .replace(/\s+/g, " ")
                .toLowerCase();

            const i18nTooLong = String(i18n?.Messages?.YOUR_MESSAGE_IS_TOO_LONG ?? "").toLowerCase();
            const looksLikeTooLongModal = (
                modalText.includes("your message is too long")
                || modalText.includes("up to 4000 characters")
                || modalText.includes("2000 character count limit")
                || modalText.includes("your_message_is_too_long")
                || modalText.includes("showlargemessagedialog")
                || (i18nTooLong && modalText.includes(i18nTooLong))
            );

            if (!looksLikeTooLongModal) return orig(...modalArgs);

            const channelId = SelectedChannelStore?.getChannelId?.();
            if (!channelId) return orig(...modalArgs);

            if (!splitAndSend(channelId)) return orig(...modalArgs);

            return undefined;
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
        const patchPopupTargets = () => {
            const targets: Array<Record<string, any>> = [];
            if (Popup && typeof Popup === "object") targets.push(Popup as Record<string, any>);
            if (ModalManager && typeof ModalManager === "object") targets.push(ModalManager as Record<string, any>);
            targets.push(
                ...(findAll(
                    (m) => m && typeof m === "object" && (
                        typeof m.show === "function"
                        || typeof m.openLazy === "function"
                        || typeof m.openModal === "function"
                        || typeof m.openModalLazy === "function"
                    )
                ) as Array<Record<string, any>>)
            );

            for (const target of targets) {
                if (patchedPopupTargets.has(target)) continue;
                patchedPopupTargets.add(target);

                for (const method of ["show", "openLazy", "openModal", "openModalLazy"] as const) {
                    try {
                        if (typeof target[method] !== "function") continue;
                        warningUnpatches.push(
                            instead(method, target, (args, orig) =>
                                handleTooLongPopup(args as any[], orig as (...args: any[]) => any)
                            )
                        );
                    } catch { }
                }
            }
        };
        const patchUploadTargets = () => {
            const targets = findAll(
                (m) => m && typeof m === "object" && typeof m.promptToUpload === "function"
            ) as Array<Record<string, any>>;

            if (UploadHandler && typeof UploadHandler === "object" && typeof UploadHandler.promptToUpload === "function") {
                targets.push(UploadHandler as Record<string, any>);
            }

            for (const target of targets) {
                if (patchedUploadTargets.has(target)) continue;
                patchedUploadTargets.add(target);

                try {
                    warningUnpatches.push(
                        instead("promptToUpload", target, ([files, channel, draftType], orig) => {
                            const file = files?.[0];
                            const channelId = channel?.id ?? SelectedChannelStore?.getChannelId?.();
                            const looksLikeAutoText = isAutoTextFile(file);
                            const isChannelDraft = draftType === 0 || draftType == null;

                            if (!channelId || !looksLikeAutoText || !isChannelDraft) {
                                return orig(files, channel, draftType);
                            }

                            if (!splitAndSend(channelId)) return orig(files, channel, draftType);

                            return undefined;
                        })
                    );
                } catch { }
            }
        };
        const patchComposerTargets = () => {
            const targets = findAll(
                (m) => m
                    && typeof m === "object"
                    && typeof m.handleSendMessage === "function"
                    && (typeof m.onResize === "function" || typeof m.getSendMessageOptions === "function")
            ) as Array<Record<string, any>>;

            for (const target of targets) {
                if (patchedComposerTargets.has(target)) continue;
                patchedComposerTargets.add(target);

                try {
                    warningUnpatches.push(
                        instead("handleSendMessage", target, (args, orig) => {
                            const [firstArg] = args as [Record<string, any> | undefined];
                            const channelId = firstArg?.channel?.id
                                ?? firstArg?.channelId
                                ?? firstArg?.id
                                ?? SelectedChannelStore?.getChannelId?.();

                            if (!channelId) return orig(...args);

                            const directContent =
                                (typeof firstArg?.content === "string" ? firstArg.content : "")
                                || (typeof firstArg?.text === "string" ? firstArg.text : "")
                                || (typeof firstArg?.message?.content === "string" ? firstArg.message.content : "");

                            if (!splitAndSend(channelId, directContent)) return orig(...args);
                            return undefined;
                        })
                    );
                } catch { }
            }
        };

        patchMessageLengthConstants();
        patchWarningTargets();
        patchPopupTargets();
        patchUploadTargets();
        patchComposerTargets();
        warningPatchInterval = setInterval(() => {
            patchWarningTargets();
            patchPopupTargets();
            patchUploadTargets();
            patchComposerTargets();
        }, 3000);

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
        patchedWarningTargets.clear();
        patchedPopupTargets.clear();
        patchedUploadTargets.clear();
        patchedComposerTargets.clear();

        restoreMessageLengthConstants();
    },
    settings,
};
