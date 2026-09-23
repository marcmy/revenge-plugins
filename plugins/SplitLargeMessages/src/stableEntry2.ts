import { findAll, findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, ReactNative } from "@vendetta/metro/common";
import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import { splitMarkdownMessageDetailed, type MarkdownSplitResult } from "./markdownSplitter";
import settings from "./settings";

const MESSAGE_LIMIT = 2000;
const NITRO_MESSAGE_LIMIT = 4000;
const MIN_SEND_DELAY_MS = 1000;
const PATCH_SWEEP_INTERVAL_MS = 5000;
const PATCH_SWEEP_MAX_ATTEMPTS = 6;
const CHANNEL_DISCOVERY_INITIAL_DELAY_MS = 250;
const CHANNEL_DISCOVERY_RETRY_INTERVAL_MS = 500;
const CHANNEL_DISCOVERY_MAX_ATTEMPTS = 3;

let unpatchSend: (() => void) | undefined;
let unpatchUpload: (() => void) | undefined;
let patchSweepInterval: ReturnType<typeof setInterval> | undefined;
let unloaded = false;
let lifecycleGeneration = 0;

const runtimeUnpatches: Array<() => void> = [];
const channelDiscoveryTimeouts = new Set<ReturnType<typeof setTimeout>>();
const patchedLengthModules = new Map<Record<string, any>, Record<string, number>>();
const patchedDialogTargets = new Set<object>();
const patchedGuardTargets = new Set<object>();
const channelQueues = new Map<string, Promise<void>>();
const inFlightSendKeys = new Set<string>();
const autoTextStates = new WeakMap<object, "processing" | "failed" | "done">();
const pendingAutoTextRestorations = new WeakMap<
    object,
    (sourceText: string) => void
>();
const localObjectIdentities = new WeakMap<object, number>();
let nextLocalObjectIdentity = 0;

function clearChannelDiscoveryTimeouts() {
    for (const timeout of channelDiscoveryTimeouts) clearTimeout(timeout);
    channelDiscoveryTimeouts.clear();
}

type MessageLocation = {
    index: number;
    message: Record<string, any>;
};

function getLocalObjectIdentity(value: any): number | null {
    if (
        value == null ||
        (typeof value !== "object" && typeof value !== "function")
    ) {
        return null;
    }

    const object = value as object;
    let identity = localObjectIdentities.get(object);

    if (identity == null) {
        identity = ++nextLocalObjectIdentity;
        localObjectIdentities.set(object, identity);
    }

    return identity;
}

function isSameGeneratedText(content: string, sourceText: string): boolean {
    const normalize = (value: string) =>
        value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

    return normalize(content) === normalize(sourceText);
}

function logDebug(...args: any[]) {
    try {
        console.log("[SplitLargeMessages]", ...args);
    } catch {}
}

function showFailure(message = "Failed to split message") {
    try {
        showToast(message, getAssetIDByName("Small"));
    } catch {}
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeObjectValues(value: any): any[] {
    try {
        return Object.values(value);
    } catch {
        return [];
    }
}

function collectTargetsWithMethods(methods: string[]): Array<Record<string, any>> {
    const targets = new Set<Record<string, any>>();

    const hasAnyMethod = (value: any) => {
        if (!value || typeof value !== "object") return false;

        try {
            return methods.some((method) => typeof value[method] === "function");
        } catch {
            return false;
        }
    };

    const addTarget = (value: any) => {
        if (!value || typeof value !== "object") return;

        try {
            if (hasAnyMethod(value)) targets.add(value as Record<string, any>);

            const proto = Object.getPrototypeOf(value);
            if (
                proto &&
                proto !== Object.prototype &&
                hasAnyMethod(proto)
            ) {
                targets.add(proto as Record<string, any>);
            }
        } catch {}
    };

    const modules = findAll((module) => {
        try {
            if (!module || typeof module !== "object") return false;
            if (hasAnyMethod(module)) return true;
            return safeObjectValues(module).some(hasAnyMethod);
        } catch {
            return false;
        }
    }) as Array<Record<string, any>>;

    for (const module of modules) {
        addTarget(module);
        for (const value of safeObjectValues(module)) addTarget(value);
    }

    return [...targets];
}

function getMessageLocation(args: any[]): MessageLocation {
    const first = args[0];
    const second = args[1];

    if (second && typeof second === "object") {
        return { index: 1, message: second };
    }

    if (first && typeof first === "object") {
        return { index: 0, message: first };
    }

    return { index: 1, message: {} };
}

function getSendPayloadIdentity(message: any): string {
    const reference = message?.message_reference ?? message?.messageReference;
    const attachments = Array.isArray(message?.attachments)
        ? message.attachments.map((attachment: any) => {
              const localIdentity =
                  getLocalObjectIdentity(attachment?.file) ??
                  getLocalObjectIdentity(attachment?.nativeFile) ??
                  getLocalObjectIdentity(attachment?.blob) ??
                  getLocalObjectIdentity(attachment?.fileData) ??
                  getLocalObjectIdentity(attachment);

              return [
                  localIdentity,
                  attachment?.id ?? null,
                  attachment?.filename ?? attachment?.name ?? null,
                  attachment?.url ?? null,
              ];
          })
        : null;
    const payload = [
        reference?.message_id ?? reference?.messageId ?? reference?.id ?? null,
        message?.allowed_mentions ?? message?.allowedMentions ?? null,
        message?.embeds ?? null,
        attachments,
        message?.sticker_ids ?? message?.stickerIds ?? null,
        message?.flags ?? null,
        message?.tts ?? null,
    ];

    try {
        return JSON.stringify(payload) ?? "";
    } catch {
        return "";
    }
}

function extractContent(value: any, depth = 0, seen = new Set<any>()): string {
    if (value == null || depth > 5) return "";
    if (typeof value === "string") return value;
    if (typeof value !== "object") return "";
    if (seen.has(value)) return "";

    seen.add(value);

    if (Array.isArray(value)) {
        let longest = "";

        for (const item of value) {
            const candidate = extractContent(item, depth + 1, seen);
            if (candidate.length > longest.length) longest = candidate;
        }

        return longest;
    }

    for (const key of [
        "content",
        "text",
        "value",
        "rawContent",
        "messageContent",
        "pendingContent",
    ]) {
        const candidate = value[key];
        if (typeof candidate === "string" && candidate.length > 0) {
            return candidate;
        }
    }

    let longest = "";

    for (const key of [
        "message",
        "draft",
        "state",
        "editor",
        "input",
        "composerState",
        "formState",
        "richValue",
        "sendMessageOptions",
    ]) {
        const candidate = extractContent(value[key], depth + 1, seen);
        if (candidate.length > longest.length) longest = candidate;
    }

    return longest;
}

function getLongestContent(values: any[]): string {
    let longest = "";

    for (const value of values) {
        const content = extractContent(value);
        if (content.length > longest.length) longest = content;
    }

    return longest;
}

function isSnowflakeLike(value: unknown): value is string {
    return typeof value === "string" && /^\d{10,25}$/.test(value);
}

function getChannelIdFromObject(value: any): string | undefined {
    if (!value || typeof value !== "object") return undefined;

    const direct = value.channelId ?? value.channel_id;
    if (isSnowflakeLike(direct)) return direct;

    const nested = value.channel?.id;
    if (isSnowflakeLike(nested)) return nested;

    const rootId = value.id;
    const looksLikeMessage =
        "content" in value ||
        "author" in value ||
        "message_reference" in value ||
        "messageReference" in value;
    const looksLikeChannel =
        !looksLikeMessage &&
        isSnowflakeLike(rootId) &&
        (
            typeof value.type === "number" ||
            "recipients" in value ||
            "parent_id" in value ||
            "parentId" in value ||
            typeof value.isPrivate === "function" ||
            typeof value.isGuildVocal === "function"
        );

    return looksLikeChannel ? rootId : undefined;
}

function resolveChannelIdFromObjects(
    SelectedChannelStore: any,
    ...values: any[]
): string | undefined {
    for (const value of values) {
        const channelId = getChannelIdFromObject(value);
        if (channelId) return channelId;
    }

    const selected = SelectedChannelStore?.getChannelId?.();
    return isSnowflakeLike(selected) ? selected : undefined;
}

function resolveSendChannelId(
    SelectedChannelStore: any,
    args: any[],
): string | undefined {
    if (isSnowflakeLike(args[0])) return args[0];

    return resolveChannelIdFromObjects(
        SelectedChannelStore,
        args[0],
        args[1],
        ...args,
    );
}

function getDraftText(channelId: string, DraftStore: any): string {
    if (!channelId || !DraftStore?.getDraft) return "";

    try {
        const typed = DraftStore.getDraft(channelId, 0);
        if (typeof typed === "string") return typed;
    } catch {}

    try {
        const basic = DraftStore.getDraft(channelId);
        if (typeof basic === "string") return basic;
    } catch {}

    return "";
}

function saveDraftText(
    channelId: string,
    text: string,
    DraftStore: any,
    DraftManager: any,
): boolean {
    if (!text || !DraftManager?.saveDraft) return false;

    const attempts = [
        () => DraftManager.saveDraft(channelId, 0, text),
        () => DraftManager.saveDraft(channelId, text, 0),
        () => DraftManager.saveDraft(channelId, text),
    ];

    for (const attempt of attempts) {
        try {
            attempt();
            if (getDraftText(channelId, DraftStore) === text) return true;
        } catch {}
    }

    return false;
}

function copyText(text: string): boolean {
    if (!text) return false;

    const Clipboard =
        findByProps("setString", "getString") ??
        (ReactNative as any).Clipboard;

    const setString = Clipboard?.setString;
    if (typeof setString !== "function") return false;

    try {
        setString.call(Clipboard, text);
        return true;
    } catch {
        return false;
    }
}

function restoreUnsentContent(
    channelId: string,
    text: string,
    DraftStore: any,
    DraftManager: any,
) {
    if (!text) return;

    const currentDraft = getDraftText(channelId, DraftStore);

    if (!currentDraft || currentDraft === text) {
        if (saveDraftText(channelId, text, DraftStore, DraftManager)) {
            showFailure("Unsent message parts restored to the draft");
            return;
        }
    }

    if (copyText(text)) {
        showFailure("Unsent message parts copied to clipboard");
        return;
    }

    showFailure("Some message parts could not be sent");
}

function clearDraftAndUploads(
    channelId: string,
    DraftManager: any,
    UploadManager: any,
) {
    for (const args of [
        [channelId, 0],
        [channelId],
    ]) {
        try {
            DraftManager?.clearDraft?.(...args);
        } catch {}

        try {
            UploadManager?.clearAll?.(...args);
        } catch {}
    }
}

function buildChunkArgs(
    templateArgs: any[],
    channelId: string,
    content: string,
    includeOriginalMessageFields: boolean,
): any[] {
    const nextArgs = [...templateArgs];
    const { index, message } = getMessageLocation(nextArgs);

    const chunkMessage = includeOriginalMessageFields
        ? { ...message, content }
        : {
              content,
              tts: false,
              invalidEmojis: message.invalidEmojis ?? [],
              validNonShortcutEmojis: message.validNonShortcutEmojis ?? [],
          };

    if (isSnowflakeLike(nextArgs[0])) {
        nextArgs[0] = channelId;
        nextArgs[1] = chunkMessage;
        return nextArgs;
    }

    if (index === 0) {
        nextArgs[0] = {
            ...chunkMessage,
            channelId: message.channelId ?? message.channel_id ?? channelId,
        };
        return nextArgs;
    }

    nextArgs[1] = chunkMessage;
    return nextArgs;
}

function findMessagePayload(
    value: any,
    depth = 0,
    seen = new Set<any>(),
): Record<string, any> | undefined {
    if (!value || typeof value !== "object" || depth > 5) return undefined;
    if (seen.has(value)) return undefined;

    seen.add(value);

    if (!Array.isArray(value)) {
        const content = value.content;
        const looksLikePayload =
            typeof content === "string" &&
            (
                "tts" in value ||
                "invalidEmojis" in value ||
                "validNonShortcutEmojis" in value ||
                "message_reference" in value ||
                "messageReference" in value ||
                "allowed_mentions" in value ||
                "allowedMentions" in value ||
                "sticker_ids" in value ||
                "stickerIds" in value
            );

        if (looksLikePayload) return value;
    }

    for (const nested of safeObjectValues(value)) {
        const payload = findMessagePayload(nested, depth + 1, seen);
        if (payload) return payload;
    }

    return undefined;
}

function isAutoTextFile(file: any): boolean {
    if (!file || typeof file !== "object") return false;

    const name = String(file.name ?? "");
    const type = String(file.type ?? "");

    return name === "message.txt" && (!type || type === "text/plain");
}

function getChannelUploads(channelId: string, UploadAttachmentStore: any): any[] {
    if (!UploadAttachmentStore?.getUploads) return [];

    try {
        const typed = UploadAttachmentStore.getUploads(channelId, 0);
        if (Array.isArray(typed)) return typed;
    } catch {}

    try {
        const basic = UploadAttachmentStore.getUploads(channelId);
        if (Array.isArray(basic)) return basic;
    } catch {}

    return [];
}

function getUploadFile(upload: any): any {
    return upload?.item?.file ?? upload?.file;
}

function isGeneratedLongMessageUpload(upload: any): boolean {
    const file = getUploadFile(upload);
    return (
        isAutoTextFile(file) &&
        (upload?.showLargeMessageDialog === true ||
            upload?.item?.showLargeMessageDialog === true)
    );
}

function enqueueChannelTask(
    channelId: string,
    task: () => Promise<void>,
    betweenTasksDelayMs = 0,
): Promise<void> {
    const hadPrevious = channelQueues.has(channelId);
    const previous = channelQueues.get(channelId) ?? Promise.resolve();

    const next = previous
        .catch(() => {})
        .then(async () => {
            if (unloaded) return;
            if (hadPrevious && betweenTasksDelayMs > 0) {
                await sleep(betweenTasksDelayMs);
            }
            await task();
        });

    channelQueues.set(channelId, next);

    const cleanup = () => {
        if (channelQueues.get(channelId) === next) {
            channelQueues.delete(channelId);
        }
    };

    void next.then(cleanup, cleanup);
    return next;
}

function patchMessageLengthConstants() {
    const patchTarget = (target: any) => {
        if (!target || typeof target !== "object") return;

        const mod = target as Record<string, any>;
        let previousValues = patchedLengthModules.get(mod);

        if (!previousValues) previousValues = {};

        let touched = false;
        let descriptors: Record<string, PropertyDescriptor>;

        try {
            descriptors = Object.getOwnPropertyDescriptors(mod);
        } catch {
            return;
        }

        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (!key.includes("MESSAGE_LENGTH")) continue;
            if (!("value" in descriptor)) continue;
            if (typeof descriptor.value !== "number") continue;
            if (descriptor.value <= 0 || descriptor.value > 10000) continue;

            try {
                if (!(key in previousValues)) {
                    previousValues[key] = descriptor.value;
                }

                mod[key] = 1_000_000;
                touched = true;
            } catch {}
        }

        if (touched) patchedLengthModules.set(mod, previousValues);
    };

    const modules = findAll((module) => {
        try {
            return (
                module &&
                typeof module === "object" &&
                Object.keys(module).some((key) =>
                    key.includes("MESSAGE_LENGTH"),
                )
            );
        } catch {
            return false;
        }
    }) as Array<Record<string, any>>;

    for (const module of modules) {
        patchTarget(module);
        for (const value of safeObjectValues(module)) patchTarget(value);
    }
}

function restoreMessageLengthConstants() {
    for (const [module, values] of patchedLengthModules) {
        for (const [key, value] of Object.entries(values)) {
            try {
                module[key] = value;
            } catch {}
        }
    }

    patchedLengthModules.clear();
}

export default {
    onLoad() {
        unloaded = false;
        clearChannelDiscoveryTimeouts();
        const loadGeneration = ++lifecycleGeneration;
        storage.splitOnWords ??= false;

        const ChannelStore = findByStoreName("ChannelStore");
        const SelectedChannelStore = findByStoreName("SelectedChannelStore");
        const UserStore = findByStoreName("UserStore");
        const MessageActions = findByProps("sendMessage", "editMessage");
        const UploadHandler = findByProps("promptToUpload");
        const UploadAttachmentStore = findByProps("getUploads");
        const DraftStore = findByProps("getDraft");
        const DraftManager = findByProps("clearDraft", "saveDraft");
        const UploadManager = findByProps("clearAll");

        if (!MessageActions || typeof MessageActions.sendMessage !== "function") {
            showFailure("SplitLargeMessages: send API unavailable");
            return;
        }

        const originalSendMessage = MessageActions.sendMessage.bind(MessageActions);

        const getMaxLength = () =>
            UserStore?.getCurrentUser?.()?.premiumType === 2
                ? NITRO_MESSAGE_LIMIT
                : MESSAGE_LIMIT;

        const getSendDelay = (channelId: string) => {
            const channel = ChannelStore?.getChannel?.(channelId);
            return Math.max(
                (channel?.rateLimitPerUser ?? 0) * 1000,
                MIN_SEND_DELAY_MS,
            );
        };

        const splitContent = (content: string): MarkdownSplitResult | false =>
            splitMarkdownMessageDetailed(
                content,
                getMaxLength(),
                Boolean(storage.splitOnWords),
            );

        const getUnsentSource = (
            split: MarkdownSplitResult,
            sentChunks: number,
        ): string => {
            if (sentChunks <= 0) return split.normalized;
            if (sentChunks >= split.chunks.length) return "";

            const sourceStart = split.sourceStarts[sentChunks];
            return typeof sourceStart === "number"
                ? split.normalized.slice(sourceStart)
                : split.normalized;
        };

        const runStandaloneSplit = (
            channelId: string,
            content: string,
            source: string,
            template?: Record<string, any>,
            onFirstSuccess?: () => void,
        ): Promise<void> => {
            const split = splitContent(content);

            if (split === false || split.chunks.length === 0) {
                showFailure();
                return Promise.resolve();
            }

            const chunks = split.chunks;
            const wasQueued = channelQueues.has(channelId);

            const queued = enqueueChannelTask(channelId, async () => {
                let sent = 0;

                try {
                    for (let index = 0; index < chunks.length; index++) {
                        const payload =
                            index === 0 && template
                                ? { ...template, content: chunks[index] }
                                : {
                                      content: chunks[index],
                                      tts: false,
                                      invalidEmojis: [],
                                      validNonShortcutEmojis: [],
                                  };

                        await originalSendMessage(channelId, payload);
                        sent++;

                        if (sent === 1) onFirstSuccess?.();

                        if (index < chunks.length - 1) {
                            await sleep(getSendDelay(channelId));
                        }
                    }
                } catch (error) {
                    console.error(
                        `[SplitLargeMessages] ${source} split send failed`,
                        error,
                    );

                    const unsent = getUnsentSource(split, sent);
                    restoreUnsentContent(
                        channelId,
                        unsent,
                        DraftStore,
                        DraftManager,
                    );

                    throw error;
                }
            }, getSendDelay(channelId));

            if (wasQueued) {
                showToast(
                    "SplitLargeMessages: queued long message",
                    getAssetIDByName("Small"),
                );
            }

            return queued;
        };

        const processAutoTextFile = async (
            channelId: string,
            file: any,
            forceRetry = false,
        ): Promise<boolean> => {
            if (!isAutoTextFile(file) || typeof file.text !== "function") {
                return false;
            }

            const state = autoTextStates.get(file);

            if (state === "processing" || state === "done") return true;
            if (state === "failed" && !forceRetry) return true;

            autoTextStates.set(file, "processing");

            let text: string;

            try {
                text = await file.text();
            } catch {
                if (state === "failed") autoTextStates.set(file, "failed");
                else autoTextStates.delete(file);
                pendingAutoTextRestorations.delete(file);
                return false;
            }

            if (!text || text.length <= getMaxLength()) {
                if (state === "failed") autoTextStates.set(file, "failed");
                else autoTextStates.delete(file);
                pendingAutoTextRestorations.delete(file);
                return false;
            }

            const split = splitContent(text);

            if (split === false || split.chunks.length === 0) {
                autoTextStates.set(file, "failed");
                pendingAutoTextRestorations.delete(file);
                showFailure();
                return true;
            }

            const chunks = split.chunks;
            const wasQueued = channelQueues.has(channelId);

            const queued = enqueueChannelTask(channelId, async () => {
                let sent = 0;

                try {
                    for (let index = 0; index < chunks.length; index++) {
                        await originalSendMessage(channelId, {
                            content: chunks[index],
                            tts: false,
                            invalidEmojis: [],
                            validNonShortcutEmojis: [],
                        });

                        sent++;

                        if (sent === 1) {
                            clearDraftAndUploads(
                                channelId,
                                DraftManager,
                                UploadManager,
                            );

                            try {
                                const restorePendingText =
                                    pendingAutoTextRestorations.get(file);
                                pendingAutoTextRestorations.delete(file);
                                restorePendingText?.(text);
                            } catch (error) {
                                console.error(
                                    "[SplitLargeMessages] failed to restore text after upload retry",
                                    error,
                                );
                            }
                        }

                        if (index < chunks.length - 1) {
                            await sleep(getSendDelay(channelId));
                        }
                    }

                    autoTextStates.set(file, "done");
                    pendingAutoTextRestorations.delete(file);
                } catch (error) {
                    console.error(
                        "[SplitLargeMessages] message.txt split send failed",
                        error,
                    );

                    if (sent === 0) {
                        autoTextStates.set(file, "failed");
                        pendingAutoTextRestorations.delete(file);
                        showFailure(
                            "SplitLargeMessages: send failed; message.txt kept for retry",
                        );
                        return;
                    }

                    autoTextStates.set(file, "done");

                    const unsent = getUnsentSource(split, sent);
                    restoreUnsentContent(
                        channelId,
                        unsent,
                        DraftStore,
                        DraftManager,
                    );
                    pendingAutoTextRestorations.delete(file);
                }
            }, getSendDelay(channelId));

            if (wasQueued) {
                showToast(
                    "SplitLargeMessages: queued long message",
                    getAssetIDByName("Small"),
                );
            }

            void queued.catch(() => {});
            return true;
        };

        const checkExistingAutoTextUploads = () => {
            if (unloaded) return;

            const channelId = SelectedChannelStore?.getChannelId?.();
            if (!isSnowflakeLike(channelId)) return;

            const uploads = getChannelUploads(channelId, UploadAttachmentStore);

            for (const upload of uploads) {
                if (!isGeneratedLongMessageUpload(upload)) continue;
                const file = getUploadFile(upload);
                const state = autoTextStates.get(file);
                if (
                    state === "processing" ||
                    state === "done" ||
                    state === "failed"
                ) {
                    continue;
                }

                void processAutoTextFile(channelId, file).catch((error) => {
                    console.error(
                        "[SplitLargeMessages] queued message.txt check failed",
                        error,
                    );
                });
            }
        };

        const patchTooLongGuardMethods = () => {
            const booleanMethods = [
                "isMessageTooLong",
                "isContentTooLong",
                "shouldShowLargeMessageDialog",
                "shouldShowMessageTooLongDialog",
            ] as const;

            const maxLengthMethods = [
                "getMaxMessageLength",
                "getMessageLengthLimit",
                "getMaxCharacterCount",
            ] as const;

            const targets = collectTargetsWithMethods([
                ...booleanMethods,
                ...maxLengthMethods,
            ]);

            for (const target of targets) {
                if (patchedGuardTargets.has(target)) continue;

                const looksLikeMessageGuardTarget = booleanMethods.some(
                    (method) => typeof target[method] === "function",
                );
                if (!looksLikeMessageGuardTarget) continue;

                patchedGuardTargets.add(target);

                for (const method of booleanMethods) {
                    if (typeof target[method] !== "function") continue;

                    try {
                        runtimeUnpatches.push(
                            instead(
                                method,
                                target,
                                (args: any[], orig: (...callArgs: any[]) => any) => {
                                    const result = orig(...args);
                                    if (result !== true) return result;

                                    const channelId =
                                        resolveChannelIdFromObjects(
                                            SelectedChannelStore,
                                            ...args,
                                        ) ??
                                        SelectedChannelStore?.getChannelId?.();

                                    const direct = getLongestContent(args);
                                    const draft = isSnowflakeLike(channelId)
                                        ? getDraftText(channelId, DraftStore)
                                        : "";
                                    const content =
                                        direct.length >= draft.length
                                            ? direct
                                            : draft;

                                    return content.length > getMaxLength()
                                        ? false
                                        : result;
                                },
                            ),
                        );
                    } catch {}
                }

                for (const method of maxLengthMethods) {
                    if (typeof target[method] !== "function") continue;

                    try {
                        runtimeUnpatches.push(
                            instead(
                                method,
                                target,
                                (args: any[], orig: (...callArgs: any[]) => any) => {
                                    const result = orig(...args);

                                    return typeof result === "number" &&
                                        result > 0 &&
                                        result <= 10000
                                        ? 1_000_000
                                        : result;
                                },
                            ),
                        );
                    } catch {}
                }
            }
        };

        const patchLargeMessageDialogs = () => {
            const methods = [
                "showLargeMessageDialog",
                "showMessageTooLongDialog",
                "openLargeMessageDialog",
            ] as const;

            const targets = collectTargetsWithMethods([...methods]);

            for (const target of targets) {
                if (patchedDialogTargets.has(target)) continue;
                patchedDialogTargets.add(target);

                for (const method of methods) {
                    if (typeof target[method] !== "function") continue;

                    try {
                        runtimeUnpatches.push(
                            instead(
                                method,
                                target,
                                (args: any[], orig: (...callArgs: any[]) => any) => {
                                    const channelId =
                                        resolveChannelIdFromObjects(
                                            SelectedChannelStore,
                                            ...args,
                                        ) ??
                                        SelectedChannelStore?.getChannelId?.();

                                    if (!isSnowflakeLike(channelId)) {
                                        return orig(...args);
                                    }

                                    const direct = getLongestContent(args);
                                    const draft = getDraftText(
                                        channelId,
                                        DraftStore,
                                    );
                                    const content =
                                        direct.length >= draft.length
                                            ? direct
                                            : draft;

                                    if (
                                        !content ||
                                        content.length <= getMaxLength()
                                    ) {
                                        return orig(...args);
                                    }

                                    const template = findMessagePayload(args);

                                    void runStandaloneSplit(
                                        channelId,
                                        content,
                                        method,
                                        template,
                                        () =>
                                            clearDraftAndUploads(
                                                channelId,
                                                DraftManager,
                                                UploadManager,
                                            ),
                                    ).catch(() => {});

                                    return undefined;
                                },
                            ),
                        );
                    } catch {}
                }
            }
        };

        let patchSweepAttempts = 0;

        const patchRuntimeTargets = () => {
            if (unloaded) return;

            patchMessageLengthConstants();
            patchTooLongGuardMethods();
            patchLargeMessageDialogs();
            checkExistingAutoTextUploads();
        };

        const preserveSendTextForAutoUpload = (
            channelId: string,
            content: string,
        ): "draft" | "clipboard" | "failed" | "empty" => {
            if (!content) return "empty";

            if (saveDraftText(channelId, content, DraftStore, DraftManager)) {
                return "draft";
            }

            return copyText(content) ? "clipboard" : "failed";
        };

        const restoreSendTextAfterAutoUpload = (
            channelId: string,
            content: string,
        ) => {
            const preserved = preserveSendTextForAutoUpload(channelId, content);

            if (preserved === "draft") {
                showFailure(
                    "SplitLargeMessages: text restored to the draft; send it again after the upload retry",
                );
                return;
            }

            if (preserved === "clipboard") {
                showFailure(
                    "SplitLargeMessages: text copied to the clipboard after upload retry",
                );
                return;
            }

            if (preserved === "empty") return;

            showFailure(
                "SplitLargeMessages: could not restore the text after upload retry",
            );
        };

        unpatchSend?.();
        unpatchUpload?.();

        unpatchSend = instead(
            "sendMessage",
            MessageActions,
            (args: any[], orig: (...callArgs: any[]) => any) => {
                const sendArgs = [...args];
                const { message } = getMessageLocation(sendArgs);
                const content = extractContent(message);
                const channelId = resolveSendChannelId(
                    SelectedChannelStore,
                    sendArgs,
                );

                if (channelId) {
                    const retryUploads = getChannelUploads(
                        channelId,
                        UploadAttachmentStore,
                    ).filter(isGeneratedLongMessageUpload);
                    const processingUpload = retryUploads.find(
                        (upload) =>
                            autoTextStates.get(getUploadFile(upload)) ===
                            "processing",
                    );
                    const pendingRetryUpload =
                        processingUpload ??
                        retryUploads.find(
                            (upload) =>
                                autoTextStates.get(getUploadFile(upload)) ===
                                "failed",
                        );

                    if (pendingRetryUpload) {
                        const file = getUploadFile(pendingRetryUpload);
                        const uploadState = autoTextStates.get(file);

                        if (content) {
                            pendingAutoTextRestorations.set(
                                file,
                                (sourceText) => {
                                    if (isSameGeneratedText(content, sourceText)) {
                                        return;
                                    }

                                    restoreSendTextAfterAutoUpload(
                                        channelId,
                                        content,
                                    );
                                },
                            );
                        } else {
                            pendingAutoTextRestorations.delete(file);
                        }

                        const preserved = preserveSendTextForAutoUpload(
                            channelId,
                            content,
                        );

                        if (preserved === "clipboard") {
                            showFailure(
                                "SplitLargeMessages: text copied to the clipboard while the upload retry runs",
                            );
                        } else if (preserved === "failed") {
                            showFailure(
                                "SplitLargeMessages: could not preserve the text while retrying the upload",
                            );
                        }

                        if (uploadState === "processing") return undefined;

                        void processAutoTextFile(channelId, file, true).then(
                            (handled) => {
                                if (handled) return;

                                restoreSendTextAfterAutoUpload(
                                    channelId,
                                    content,
                                );
                                showFailure(
                                    "SplitLargeMessages: could not retry the generated message.txt upload",
                                );
                            },
                            (error) => {
                                console.error(
                                    "[SplitLargeMessages] message.txt retry failed",
                                    error,
                                );
                                restoreSendTextAfterAutoUpload(
                                    channelId,
                                    content,
                                );
                                showFailure(
                                    "SplitLargeMessages: could not retry the generated message.txt upload",
                                );
                            },
                        );
                        return undefined;
                    }
                }

                if (
                    !channelId ||
                    !content ||
                    content.length <= getMaxLength()
                ) {
                    return orig(...sendArgs);
                }

                const split = splitContent(content);

                if (split === false || split.chunks.length === 0) {
                    showFailure();
                    return undefined;
                }

                const chunks = split.chunks;
                const sendKey =
                    JSON.stringify([
                        channelId,
                        content,
                        getSendPayloadIdentity(message),
                    ]) ?? "";
                if (inFlightSendKeys.has(sendKey)) {
                    showToast(
                        "SplitLargeMessages: identical long message already queued",
                        getAssetIDByName("Small"),
                    );
                    return undefined;
                }

                inFlightSendKeys.add(sendKey);
                const wasQueued = channelQueues.has(channelId);

                const queued = enqueueChannelTask(channelId, async () => {
                    let sent = 0;

                    try {
                        for (let index = 0; index < chunks.length; index++) {
                            if (index === 0) {
                                const firstArgs = buildChunkArgs(
                                    sendArgs,
                                    channelId,
                                    chunks[index],
                                    true,
                                );
                                await orig(...firstArgs);
                            } else {
                                await originalSendMessage(channelId, {
                                    content: chunks[index],
                                    tts: false,
                                    invalidEmojis:
                                        message.invalidEmojis ?? [],
                                    validNonShortcutEmojis:
                                        message.validNonShortcutEmojis ?? [],
                                });
                            }

                            sent++;

                            if (index < chunks.length - 1) {
                                await sleep(getSendDelay(channelId));
                            }
                        }
                    } catch (error) {
                        console.error(
                            "[SplitLargeMessages] split send failed",
                            error,
                        );

                        const unsent = getUnsentSource(split, sent);
                        restoreUnsentContent(
                            channelId,
                            unsent,
                            DraftStore,
                            DraftManager,
                        );

                        throw error;
                    }
                }, getSendDelay(channelId));

                void queued.then(
                    () => inFlightSendKeys.delete(sendKey),
                    () => inFlightSendKeys.delete(sendKey),
                );

                if (wasQueued) {
                    showToast(
                        "SplitLargeMessages: queued long message",
                        getAssetIDByName("Small"),
                    );
                }

                return queued;
            },
        );

        if (UploadHandler && typeof UploadHandler.promptToUpload === "function") {
            unpatchUpload = instead(
                "promptToUpload",
                UploadHandler,
                (args: any[], orig: (...callArgs: any[]) => any) => {
                    const [files, channel, draftType] = args as [
                        any[],
                        any,
                        number | undefined,
                    ];

                    const file = files?.[0];
                    const channelId =
                        resolveChannelIdFromObjects(
                            SelectedChannelStore,
                            channel,
                        ) ?? SelectedChannelStore?.getChannelId?.();
                    const isChannelDraft =
                        draftType === 0 || draftType == null;

                    if (
                        !isSnowflakeLike(channelId) ||
                        !isChannelDraft ||
                        !isAutoTextFile(file)
                    ) {
                        return orig(...args);
                    }

                    const forceRetry =
                        autoTextStates.get(file) === "failed";

                    void processAutoTextFile(
                        channelId,
                        file,
                        forceRetry,
                    )
                        .then((handled) => {
                            if (!handled) return orig(...args);
                        })
                        .catch((error) => {
                            console.error(
                                "[SplitLargeMessages] message.txt interception failed",
                                error,
                            );
                            return orig(...args);
                        });

                    return undefined;
                },
            );
        }

        const onChannelSelect = () => {
            clearChannelDiscoveryTimeouts();

            const scheduleDiscoveryAttempt = (attempt: number) => {
                let timeout: ReturnType<typeof setTimeout>;
                timeout = setTimeout(() => {
                    channelDiscoveryTimeouts.delete(timeout);
                    if (unloaded || loadGeneration !== lifecycleGeneration) return;

                    patchRuntimeTargets();

                    if (attempt + 1 < CHANNEL_DISCOVERY_MAX_ATTEMPTS) {
                        scheduleDiscoveryAttempt(attempt + 1);
                    }
                },
                    attempt === 0
                        ? CHANNEL_DISCOVERY_INITIAL_DELAY_MS
                        : CHANNEL_DISCOVERY_RETRY_INTERVAL_MS,
                );
                channelDiscoveryTimeouts.add(timeout);
            };

            scheduleDiscoveryAttempt(0);
        };

        try {
            FluxDispatcher?.subscribe?.("CHANNEL_SELECT", onChannelSelect);
            runtimeUnpatches.push(() =>
                FluxDispatcher?.unsubscribe?.(
                    "CHANNEL_SELECT",
                    onChannelSelect,
                ),
            );
        } catch {}

        patchRuntimeTargets();

        patchSweepInterval = setInterval(() => {
            patchRuntimeTargets();
            patchSweepAttempts++;

            if (
                patchSweepAttempts >= PATCH_SWEEP_MAX_ATTEMPTS &&
                patchSweepInterval
            ) {
                clearInterval(patchSweepInterval);
                patchSweepInterval = undefined;
            }
        }, PATCH_SWEEP_INTERVAL_MS);

        logDebug("Loaded reviewed split pipeline");
    },

    onUnload() {
        unloaded = true;
        lifecycleGeneration++;
        clearChannelDiscoveryTimeouts();

        unpatchUpload?.();
        unpatchUpload = undefined;

        unpatchSend?.();
        unpatchSend = undefined;

        while (runtimeUnpatches.length) {
            try {
                runtimeUnpatches.pop()?.();
            } catch {}
        }

        if (patchSweepInterval) {
            clearInterval(patchSweepInterval);
            patchSweepInterval = undefined;
        }

        patchedDialogTargets.clear();
        patchedGuardTargets.clear();
        channelQueues.clear();
        inFlightSendKeys.clear();
        restoreMessageLengthConstants();
    },

    settings,
};
