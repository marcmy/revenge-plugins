import { find, findAll, findByName, findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, ReactNative } from "@vendetta/metro/common";
import { after, before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { findInReactTree } from "@vendetta/utils";
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
const MESSAGE_COMPOSER_GUARD_METHODS = [
    "isMessageTooLong",
    "isContentTooLong",
    "shouldShowLargeMessageDialog",
    "shouldShowMessageTooLongDialog",
] as const;
const MESSAGE_COMPOSER_SPECIFIC_GUARD_METHODS = [
    "isMessageTooLong",
    "shouldShowLargeMessageDialog",
    "shouldShowMessageTooLongDialog",
] as const;

let unpatchSend: (() => void) | undefined;
let unpatchUpload: (() => void) | undefined;
let patchSweepInterval: ReturnType<typeof setInterval> | undefined;
let unloaded = false;
let lifecycleGeneration = 0;

const runtimeUnpatches: Array<() => void> = [];
const channelDiscoveryTimeouts = new Set<ReturnType<typeof setTimeout>>();
const patchedLengthModules = new Map<Record<string, any>, Record<string, number>>();
const patchedDialogTargets = new Set<object>();
const patchedComposerTargets = new Set<object>();
const patchedLiveComposerInstances = new Set<object>();
const liveComposerAttachTimeouts = new Set<ReturnType<typeof setTimeout>>();
const patchedNativeMaxLengthTargets = new Set<object>();
const patchedGuardTargets = new Set<object>();
const channelQueues = new Map<string, Promise<void>>();
const inFlightSendKeys = new Set<string>();
const pendingComposerSends = new Map<string, PendingComposerSend>();
const activeComposerFirstChunks = new Map<string, string>();
const autoTextStates = new WeakMap<object, "processing" | "failed" | "done">();
const autoTextProcessingGenerations = new WeakMap<object, number>();
const autoTextSourceTexts = new WeakMap<object, string>();
const autoTextFirstChunkSent = new WeakSet<object>();
const pendingAutoTextRestorations = new WeakMap<object, string[]>();
const pendingAutoTextFirstChunkSends = new WeakMap<
    object,
    PendingAutoTextSends
>();
const autoTextFirstChunkStarted = new WeakSet<object>();
const localObjectIdentities = new WeakMap<object, number>();
let nextLocalObjectIdentity = 0;

type PendingAutoTextAttachmentSend = {
    uploads: any[];
    send: (
        content: string,
        includeContent: boolean,
        excludeUploads: any[],
    ) => Promise<boolean>;
};

type PendingAutoTextSends = {
    first?: PendingAutoTextAttachmentSend;
    trailing: PendingAutoTextAttachmentSend[];
};

type PendingComposerSend = {
    channelId: string;
    originalContent: string;
    firstChunk: string;
    split: MarkdownSplitResult;
    sendKey: string;
    target: Record<string, any>;
    restoreTimeout: ReturnType<typeof setTimeout>;
};

function clearChannelDiscoveryTimeouts() {
    for (const timeout of channelDiscoveryTimeouts) clearTimeout(timeout);
    channelDiscoveryTimeouts.clear();
}

function clearLiveComposerAttachTimeouts() {
    for (const timeout of liveComposerAttachTimeouts) clearTimeout(timeout);
    liveComposerAttachTimeouts.clear();
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

function findChatInputWrapper() {
    try {
        const byName = findByName("ChatInputGuardWrapper", false);
        if (byName) return byName;
    } catch {}

    return find((module: any) => {
        const name =
            module?.default?.type?.displayName ??
            module?.default?.displayName ??
            module?.type?.displayName ??
            "";
        return name === "ChatInputGuardWrapper" || /ChatInput.*Wrapper/i.test(name);
    });
}

function findChatInputRef(ret: any) {
    const root = ret?.props?.children ?? ret;
    return (
        findInReactTree(root, (node: any) => node?.props?.chatInputRef)?.props
            ?.chatInputRef ??
        findInReactTree(root, (node: any) => node?.chatInputRef)?.chatInputRef
    );
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

function isGeneratedFileAttachment(
    attachment: any,
    file: any,
    upload: any,
): boolean {
    const localFile =
        attachment?.file ??
        attachment?.nativeFile ??
        attachment?.blob ??
        attachment?.fileData ??
        attachment?.item?.file;
    if (attachment === file || localFile === file) return true;

    const uploadId = upload?.id ?? upload?.item?.id;
    const attachmentId =
        attachment?.id ?? attachment?.uploadId ?? attachment?.item?.id;
    return (
        isGeneratedLongMessageUpload(attachment) ||
        (uploadId != null &&
            attachmentId != null &&
            String(uploadId) === String(attachmentId))
    );
}

function attachmentMatchesUpload(attachment: any, upload: any): boolean {
    const file = getUploadFile(upload);
    const attachmentFile =
        attachment?.file ??
        attachment?.nativeFile ??
        attachment?.blob ??
        attachment?.fileData ??
        attachment?.item?.file;
    if (file && (attachment === file || attachmentFile === file)) return true;

    const uploadId = upload?.id ?? upload?.item?.id;
    const attachmentId =
        attachment?.id ?? attachment?.uploadId ?? attachment?.item?.id;
    return (
        uploadId != null &&
        attachmentId != null &&
        String(uploadId) === String(attachmentId)
    );
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

    const hasMessageComposerGuard = (value: any) => {
        if (!value || typeof value !== "object") return false;

        try {
            return MESSAGE_COMPOSER_SPECIFIC_GUARD_METHODS.some(
                (method) => typeof value[method] === "function",
            );
        } catch {
            return false;
        }
    };

    const hasMessageLengthConstant = (value: any) => {
        if (!value || typeof value !== "object") return false;

        try {
            const descriptors = Object.getOwnPropertyDescriptors(value);
            return Object.entries(descriptors).some(([key, descriptor]) => {
                if (!key.includes("MESSAGE_LENGTH")) return false;
                if (!("value" in descriptor)) return false;
                return (
                    typeof descriptor.value === "number" &&
                    descriptor.value > 0 &&
                    descriptor.value <= 10000
                );
            });
        } catch {
            return false;
        }
    };

    const isMessageLengthTarget = (value: any) =>
        hasMessageComposerGuard(value) || hasMessageLengthConstant(value);

    const modules = findAll((module) => {
        try {
            return (
                module &&
                typeof module === "object" &&
                (isMessageLengthTarget(module) ||
                    safeObjectValues(module).some(isMessageLengthTarget))
            );
        } catch {
            return false;
        }
    }) as Array<Record<string, any>>;

    for (const module of modules) {
        const values = safeObjectValues(module);

        if (isMessageLengthTarget(module)) patchTarget(module);

        for (const value of values) {
            if (isMessageLengthTarget(value)) patchTarget(value);
        }
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
        const originalPromptToUpload =
            typeof UploadHandler?.promptToUpload === "function"
                ? UploadHandler.promptToUpload.bind(UploadHandler)
                : undefined;
        const UploadAttachmentStore = findByProps("getUploads");
        const DraftStore = findByStoreName("DraftStore") ?? findByProps("getDraft");
        const DraftManager = findByProps("clearDraft", "saveDraft");
        const UploadManager = findByProps("clearAll");
        const NativeMessageMaxLength =
            findByProps("getMaxMessageLength", "default") ??
            findByProps("getMaxMessageLength");

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

        let currentComposerInputRef: any;
        let liveChatInputRefPatchInstalled = false;
        let nativeMaxLengthDebugShown = false;

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

        const getAutoTextState = (file: any) => {
            const state = autoTextStates.get(file);

            if (
                state !== "processing" ||
                autoTextProcessingGenerations.get(file) === loadGeneration
            ) {
                return state;
            }

            autoTextStates.delete(file);
            autoTextProcessingGenerations.delete(file);
            autoTextSourceTexts.delete(file);
            autoTextFirstChunkSent.delete(file);
            autoTextFirstChunkStarted.delete(file);
            pendingAutoTextFirstChunkSends.delete(file);
            return undefined;
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
            allowOtherUploads = false,
        ): Promise<boolean> => {
            if (!isAutoTextFile(file) || typeof file.text !== "function") {
                return false;
            }

            const state = getAutoTextState(file);

            if (state === "processing" || state === "done") return true;
            if (state === "failed" && !forceRetry) return true;

            const getOtherUploads = () =>
                getChannelUploads(channelId, UploadAttachmentStore).filter(
                    (upload) => getUploadFile(upload) !== file,
                );

            if (!allowOtherUploads && getOtherUploads().length > 0) {
                autoTextStates.set(file, "failed");
                return false;
            }

            autoTextFirstChunkSent.delete(file);
            autoTextFirstChunkStarted.delete(file);
            autoTextStates.set(file, "processing");
            autoTextProcessingGenerations.set(file, loadGeneration);

            let text: string;

            try {
                text = await file.text();
            } catch {
                restorePendingAutoTextSendTexts(channelId, file);
                if (state === "failed") autoTextStates.set(file, "failed");
                else autoTextStates.delete(file);
                autoTextProcessingGenerations.delete(file);
                autoTextSourceTexts.delete(file);
                pendingAutoTextFirstChunkSends.delete(file);
                return false;
            }

            if (unloaded || loadGeneration !== lifecycleGeneration) {
                if (autoTextProcessingGenerations.get(file) !== loadGeneration) {
                    return true;
                }

                restorePendingAutoTextSendTexts(channelId, file);
                if (state === "failed") autoTextStates.set(file, "failed");
                else autoTextStates.delete(file);
                autoTextProcessingGenerations.delete(file);
                autoTextSourceTexts.delete(file);
                pendingAutoTextFirstChunkSends.delete(file);
                return false;
            }

            autoTextSourceTexts.set(file, text);

            if (!text || text.length <= getMaxLength()) {
                restorePendingAutoTextSendTexts(channelId, file, text);
                if (state === "failed") autoTextStates.set(file, "failed");
                else autoTextStates.delete(file);
                autoTextProcessingGenerations.delete(file);
                autoTextSourceTexts.delete(file);
                pendingAutoTextFirstChunkSends.delete(file);
                return false;
            }

            const split = splitContent(text);

            if (split === false || split.chunks.length === 0) {
                restorePendingAutoTextSendTexts(channelId, file, text);
                autoTextStates.set(file, "failed");
                autoTextProcessingGenerations.delete(file);
                pendingAutoTextFirstChunkSends.delete(file);
                showFailure();
                return false;
            }

            const chunks = split.chunks;
            const wasQueued = channelQueues.has(channelId);

            const queued = enqueueChannelTask(channelId, async () => {
                let sent = 0;

                if (unloaded || loadGeneration !== lifecycleGeneration) {
                    if (
                        autoTextProcessingGenerations.get(file) ===
                        loadGeneration
                    ) {
                        if (state === "failed") {
                            autoTextStates.set(file, "failed");
                        } else {
                            autoTextStates.delete(file);
                        }
                        autoTextProcessingGenerations.delete(file);
                        pendingAutoTextFirstChunkSends.delete(file);

                        const restaged = await stageAutoTextFileForRetry(
                            channelId,
                            file,
                        );
                        restorePendingAutoTextSendTexts(
                            channelId,
                            file,
                            text,
                            restaged ? undefined : split.normalized,
                        );
                    }
                    return;
                }

                if (
                    getOtherUploads().length > 0 &&
                    !pendingAutoTextFirstChunkSends.has(file)
                ) {
                    autoTextStates.set(file, "failed");
                    autoTextProcessingGenerations.delete(file);
                    pendingAutoTextFirstChunkSends.delete(file);
                    const restaged = await stageAutoTextFileForRetry(
                        channelId,
                        file,
                    );
                    restorePendingAutoTextSendTexts(
                        channelId,
                        file,
                        text,
                        restaged ? undefined : split.normalized,
                    );
                    showFailure(
                        "SplitLargeMessages: other attachments are still staged; retry the generated text with them or remove them first",
                    );
                    return;
                }

                try {
                    for (let index = 0; index < chunks.length; index++) {
                        const pendingSends =
                            index === 0
                                ? pendingAutoTextFirstChunkSends.get(file)
                                : undefined;
                        const sendFirstChunk = pendingSends?.first;

                        if (index === 0) autoTextFirstChunkStarted.add(file);

                        let firstChunkAttachmentsSent = false;
                        if (sendFirstChunk) {
                            firstChunkAttachmentsSent =
                                await sendFirstChunk.send(
                                    chunks[index],
                                    true,
                                    [],
                                );
                        }

                        if (!firstChunkAttachmentsSent) {
                            await originalSendMessage(channelId, {
                                content: chunks[index],
                                tts: false,
                                invalidEmojis: [],
                                validNonShortcutEmojis: [],
                            });
                        }

                        sent++;

                        if (sent === 1) {
                            autoTextFirstChunkSent.add(file);

                            const successfullySentUploads = [
                                ...(firstChunkAttachmentsSent
                                    ? (sendFirstChunk?.uploads ?? [])
                                    : []),
                            ];
                            let trailingIndex = 0;

                            while (true) {
                                const currentSends =
                                    pendingAutoTextFirstChunkSends.get(file);
                                const trailingSend =
                                    currentSends?.trailing[trailingIndex++];
                                if (!trailingSend) break;

                                try {
                                    const didSend = await trailingSend.send(
                                        "",
                                        false,
                                        successfullySentUploads,
                                    );
                                    if (!didSend) continue;
                                    for (const upload of trailingSend.uploads) {
                                        if (
                                            !successfullySentUploads.some(
                                                (sentUpload) =>
                                                    getUploadFile(sentUpload) ===
                                                    getUploadFile(upload),
                                            )
                                        ) {
                                            successfullySentUploads.push(upload);
                                        }
                                    }
                                } catch (error) {
                                    console.error(
                                        "[SplitLargeMessages] failed to send other staged attachments",
                                        error,
                                    );
                                }
                            }

                            const sentUploadFiles = new Set(
                                successfullySentUploads.map(getUploadFile),
                            );
                            const uploadsToRestage = getOtherUploads().filter(
                                (upload) =>
                                    !sentUploadFiles.has(getUploadFile(upload)),
                            );
                            pendingAutoTextFirstChunkSends.delete(file);
                            clearDraftAndUploads(
                                channelId,
                                DraftManager,
                                UploadManager,
                            );

                            let attachmentsRestaged = false;
                            let attachmentRestoreFailed = false;
                            for (const upload of uploadsToRestage) {
                                const uploadFile = getUploadFile(upload);
                                if (!uploadFile) {
                                    attachmentRestoreFailed = true;
                                    continue;
                                }

                                if (
                                    await stageAutoTextFileForRetry(
                                        channelId,
                                        uploadFile,
                                    )
                                ) {
                                    attachmentsRestaged = true;
                                } else {
                                    attachmentRestoreFailed = true;
                                }
                            }
                            if (attachmentsRestaged) {
                                showFailure(
                                    "SplitLargeMessages: other attachments remain staged; send them separately",
                                );
                            }
                            if (attachmentRestoreFailed) {
                                showFailure(
                                    "SplitLargeMessages: could not restore every other attachment after the text send",
                                );
                            }
                        }

                        if (index < chunks.length - 1) {
                            await sleep(getSendDelay(channelId));
                        }
                    }

                    restorePendingAutoTextSendTexts(channelId, file, text);
                    autoTextStates.set(file, "done");
                    autoTextProcessingGenerations.delete(file);
                    pendingAutoTextFirstChunkSends.delete(file);
                } catch (error) {
                    console.error(
                        "[SplitLargeMessages] message.txt split send failed",
                        error,
                    );

                    if (sent === 0) {
                        autoTextStates.set(file, "failed");
                        autoTextProcessingGenerations.delete(file);
                        pendingAutoTextFirstChunkSends.delete(file);
                        const restaged = await stageAutoTextFileForRetry(
                            channelId,
                            file,
                        );
                        restorePendingAutoTextSendTexts(
                            channelId,
                            file,
                            text,
                            restaged ? undefined : split.normalized,
                        );
                        showFailure(
                            restaged
                                ? "SplitLargeMessages: send failed; message.txt kept for retry"
                                : "SplitLargeMessages: send failed; original text restored for retry",
                        );
                        return;
                    }

                    autoTextStates.set(file, "done");
                    autoTextProcessingGenerations.delete(file);

                    const unsent = getUnsentSource(split, sent);
                    restorePendingAutoTextSendTexts(
                        channelId,
                        file,
                        text,
                        unsent,
                    );
                    pendingAutoTextFirstChunkSends.delete(file);
                }
            }, getSendDelay(channelId));

            if (wasQueued) {
                showToast(
                    "SplitLargeMessages: queued long message",
                    getAssetIDByName("Small"),
                );
            }

            void queued.then(
                async () => {
                    if (
                        autoTextStates.get(file) !== "processing" ||
                        autoTextProcessingGenerations.get(file) !==
                            loadGeneration ||
                        (!unloaded && loadGeneration === lifecycleGeneration)
                    ) {
                        return;
                    }

                    if (state === "failed") autoTextStates.set(file, "failed");
                    else autoTextStates.delete(file);
                    autoTextProcessingGenerations.delete(file);
                    pendingAutoTextFirstChunkSends.delete(file);

                    const restaged = await stageAutoTextFileForRetry(
                        channelId,
                        file,
                    );
                    restorePendingAutoTextSendTexts(
                        channelId,
                        file,
                        text,
                        restaged ? undefined : split.normalized,
                    );
                },
                (error) => {
                    console.error(
                        "[SplitLargeMessages] generated upload queue failed",
                        error,
                    );
                },
            );
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
                const state = getAutoTextState(file);
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

        const rewriteComposerContent = (
            value: any,
            originalContent: string,
            replacement: string,
            depth = 0,
        ): any => {
            if (depth > 4 || value == null) return value;
            if (typeof value === "string") {
                return value === originalContent ? replacement : value;
            }
            if (typeof value !== "object") return value;

            if (Array.isArray(value)) {
                let changed = false;
                const next = value.map((item) => {
                    const rewritten = rewriteComposerContent(
                        item,
                        originalContent,
                        replacement,
                        depth + 1,
                    );
                    if (rewritten !== item) changed = true;
                    return rewritten;
                });
                return changed ? next : value;
            }

            const directKeys = [
                "content",
                "text",
                "value",
                "rawContent",
                "messageContent",
                "pendingContent",
            ] as const;
            const nestedKeys = [
                "message",
                "draft",
                "state",
                "editor",
                "input",
                "composerState",
                "formState",
                "richValue",
                "sendMessageOptions",
            ] as const;

            let changed = false;
            const next = { ...value };

            for (const key of directKeys) {
                if (next[key] !== originalContent) continue;
                next[key] = replacement;
                changed = true;
            }

            for (const key of nestedKeys) {
                if (!(key in next)) continue;
                const rewritten = rewriteComposerContent(
                    next[key],
                    originalContent,
                    replacement,
                    depth + 1,
                );
                if (rewritten === next[key]) continue;
                next[key] = rewritten;
                changed = true;
            }

            return changed ? next : value;
        };

        const restoreComposerBridge = (pending: PendingComposerSend) => {
            if (pendingComposerSends.get(pending.channelId) !== pending) return;

            pendingComposerSends.delete(pending.channelId);
            inFlightSendKeys.delete(pending.sendKey);

            const currentDraft = getDraftText(pending.channelId, DraftStore);
            if (currentDraft === pending.firstChunk || currentDraft === "") {
                try {
                    pending.target.handleTextChanged?.(pending.originalContent);
                } catch {}

                saveDraftText(
                    pending.channelId,
                    pending.originalContent,
                    DraftStore,
                    DraftManager,
                );
            } else if (currentDraft !== pending.originalContent) {
                restoreUnsentContent(
                    pending.channelId,
                    pending.originalContent,
                    DraftStore,
                    DraftManager,
                );
            }
        };

        const patchComposerSendTargets = () => {
            const targets = collectTargetsWithMethods(["handleSendMessage"]);
            let patchedCount = 0;

            for (const target of targets) {
                if (patchedComposerTargets.has(target)) continue;
                if (typeof target.handleSendMessage !== "function") continue;

                // Discord's actual chat-input ref exposes handleTextChanged
                // alongside handleSendMessage. Requiring both avoids patching
                // unrelated Metro objects that happen to share the generic
                // handleSendMessage method name.
                if (typeof target.handleTextChanged !== "function") continue;

                try {
                    runtimeUnpatches.push(
                        instead(
                            "handleSendMessage",
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

                                // Handler arguments describe what the user
                                // actually submitted. The draft is only a
                                // fallback when those args carry no content.
                                const content = direct || draft;

                                const activeFirstChunk =
                                    activeComposerFirstChunks.get(channelId);
                                if (
                                    activeFirstChunk &&
                                    content === activeFirstChunk
                                ) {
                                    return undefined;
                                }

                                if (
                                    !content ||
                                    content.length <= getMaxLength()
                                ) {
                                    return orig(...args);
                                }

                                // Do not early-bridge a send with staged uploads:
                                // the regular upload/send path owns those.
                                const uploads = getChannelUploads(
                                    channelId,
                                    UploadAttachmentStore,
                                );
                                if (uploads.length > 0) {
                                    return orig(...args);
                                }

                                const split = splitContent(content);
                                if (
                                    split === false ||
                                    split.chunks.length === 0
                                ) {
                                    return orig(...args);
                                }

                                const sendKey =
                                    JSON.stringify([
                                        "composer",
                                        channelId,
                                        content,
                                    ]) ?? "";

                                if (inFlightSendKeys.has(sendKey)) {
                                    showToast(
                                        "SplitLargeMessages: identical long message already queued",
                                        getAssetIDByName("Small"),
                                    );
                                    return undefined;
                                }

                                const existing =
                                    pendingComposerSends.get(channelId);
                                if (existing) {
                                    if (
                                        existing.originalContent === content
                                    ) {
                                        return undefined;
                                    }

                                    return orig(...args);
                                }

                                const firstChunk = split.chunks[0];
                                inFlightSendKeys.add(sendKey);

                                const pending = {
                                    channelId,
                                    originalContent: content,
                                    firstChunk,
                                    split,
                                    sendKey,
                                    target,
                                    restoreTimeout:
                                        undefined as unknown as ReturnType<
                                            typeof setTimeout
                                        >,
                                } satisfies PendingComposerSend;

                                pending.restoreTimeout = setTimeout(
                                    () => restoreComposerBridge(pending),
                                    5000,
                                );
                                pendingComposerSends.set(
                                    channelId,
                                    pending,
                                );

                                try {
                                    // Make Discord's native composer validation
                                    // see a legal first chunk, then let its real
                                    // handler construct reply/mention metadata.
                                    target.handleTextChanged(firstChunk);
                                } catch {
                                    clearTimeout(
                                        pending.restoreTimeout,
                                    );
                                    pendingComposerSends.delete(
                                        channelId,
                                    );
                                    inFlightSendKeys.delete(sendKey);
                                    return orig(...args);
                                }

                                const rewrittenArgs = args.map((arg) =>
                                    rewriteComposerContent(
                                        arg,
                                        content,
                                        firstChunk,
                                    ),
                                );

                                return orig(...rewrittenArgs);
                            },
                        ),
                    );

                    patchedComposerTargets.add(target);
                    patchedCount++;
                } catch {}
            }

            if (patchedCount > 0) {
                logDebug(
                    "Patched composer handleSendMessage targets",
                    patchedCount,
                );
            }
        };

        const prepareLiveComposerSplit = (
            target: Record<string, any>,
        ): PendingComposerSend | undefined => {
            const channelId = SelectedChannelStore?.getChannelId?.();
            if (!isSnowflakeLike(channelId)) return undefined;

            const content = getDraftText(channelId, DraftStore);
            if (!content || content.length <= getMaxLength()) return undefined;

            const existing = pendingComposerSends.get(channelId);
            if (existing) return existing;

            const uploads = getChannelUploads(
                channelId,
                UploadAttachmentStore,
            );
            if (uploads.length > 0) return undefined;

            const split = splitContent(content);
            if (split === false || split.chunks.length === 0) {
                return undefined;
            }

            const sendKey =
                JSON.stringify(["live-composer", channelId, content]) ?? "";
            if (inFlightSendKeys.has(sendKey)) return undefined;

            const pending = {
                channelId,
                originalContent: content,
                firstChunk: split.chunks[0],
                split,
                sendKey,
                target,
                restoreTimeout:
                    undefined as unknown as ReturnType<typeof setTimeout>,
            } satisfies PendingComposerSend;

            inFlightSendKeys.add(sendKey);
            pendingComposerSends.set(channelId, pending);
            pending.restoreTimeout = setTimeout(
                () => restoreComposerBridge(pending),
                5000,
            );

            try {
                target.handleTextChanged(pending.firstChunk);
                try {
                    DraftStore?.setDraft?.(channelId, pending.firstChunk, 0);
                } catch {}
            } catch {
                clearTimeout(pending.restoreTimeout);
                pendingComposerSends.delete(channelId);
                inFlightSendKeys.delete(sendKey);
                return undefined;
            }

            logDebug("Prepared live composer split", channelId);
            return pending;
        };

        const patchLiveComposerInstance = (
            inputRef: any,
            attempt = 0,
        ) => {
            if (unloaded || loadGeneration !== lifecycleGeneration) return;

            currentComposerInputRef = inputRef;
            const target = inputRef?.current;

            if (!target?.handleTextChanged) {
                if (attempt >= 40) {
                    logDebug("Live ChatInput ref never became ready");
                    return;
                }

                let timeout: ReturnType<typeof setTimeout>;
                timeout = setTimeout(() => {
                    liveComposerAttachTimeouts.delete(timeout);
                    patchLiveComposerInstance(inputRef, attempt + 1);
                }, 100);
                liveComposerAttachTimeouts.add(timeout);
                return;
            }

            if (patchedLiveComposerInstances.has(target)) return;

            let patchedCount = 0;
            for (const method of [
                "handlePressSend",
                "handleSendMessage",
            ] as const) {
                if (typeof target[method] !== "function") continue;

                try {
                    runtimeUnpatches.push(
                        before(method, target, () => {
                            const channelId =
                                SelectedChannelStore?.getChannelId?.();
                            if (!isSnowflakeLike(channelId)) return;

                            const draft = getDraftText(
                                channelId,
                                DraftStore,
                            );
                            if (
                                !draft ||
                                draft.length <= getMaxLength()
                            ) {
                                return;
                            }

                            const uploads = getChannelUploads(
                                channelId,
                                UploadAttachmentStore,
                            );
                            if (uploads.length > 0) return;

                            const existing =
                                pendingComposerSends.get(channelId);
                            if (existing) return;

                            const pending =
                                prepareLiveComposerSplit(target);
                            if (!pending) {
                                showToast(
                                    `SplitLM debug: ${method} hook ran, split was not prepared`,
                                    getAssetIDByName("Small"),
                                );
                                return;
                            }

                            showToast(
                                `SplitLM debug: ${method} intercepted`,
                                getAssetIDByName("Small"),
                            );
                            logDebug(
                                "Direct live composer interception",
                                method,
                                channelId,
                                draft.length,
                                pending.firstChunk.length,
                            );
                        }),
                    );
                    patchedCount++;
                } catch (error) {
                    console.error(
                        `[SplitLargeMessages] failed to patch live ${method}`,
                        error,
                    );
                }
            }

            if (patchedCount > 0) {
                patchedLiveComposerInstances.add(target);
                logDebug(
                    "Patched live ChatInput instance",
                    patchedCount,
                );
            }
        };

        const patchLiveChatInputRef = () => {
            if (liveChatInputRefPatchInstalled) return;

            const ChatInputGuardWrapper = findChatInputWrapper();
            if (!ChatInputGuardWrapper) {
                logDebug("ChatInputGuardWrapper not found");
                return;
            }

            try {
                runtimeUnpatches.push(
                    after(
                        "default",
                        ChatInputGuardWrapper,
                        (_args: any[], ret: any) => {
                            try {
                                const inputRef = findChatInputRef(ret);
                                if (inputRef) {
                                    currentComposerInputRef = inputRef;
                                    patchLiveComposerInstance(inputRef);
                                }
                            } catch {}
                            return ret;
                        },
                    ),
                );
                liveChatInputRefPatchInstalled = true;
                logDebug("Installed live ChatInput ref capture");
            } catch (error) {
                console.error(
                    "[SplitLargeMessages] failed to capture live chat input ref",
                    error,
                );
            }
        };

        const patchNativeMessageMaxLength = () => {
            const target = NativeMessageMaxLength;
            if (
                !target ||
                patchedNativeMaxLengthTargets.has(target) ||
                typeof target.getMaxMessageLength !== "function"
            ) {
                return;
            }

            try {
                runtimeUnpatches.push(
                    instead(
                        "getMaxMessageLength",
                        target,
                        (args: any[], orig: (...callArgs: any[]) => any) => {
                            const result = orig(...args);
                            if (
                                typeof result !== "number" ||
                                result <= 0 ||
                                result > 10000
                            ) {
                                return result;
                            }

                            const channelId =
                                SelectedChannelStore?.getChannelId?.();
                            const draft = isSnowflakeLike(channelId)
                                ? getDraftText(channelId, DraftStore)
                                : "";

                            if (draft.length <= result) {
                                nativeMaxLengthDebugShown = false;
                                return result;
                            }

                            if (!nativeMaxLengthDebugShown) {
                                nativeMaxLengthDebugShown = true;
                                showToast(
                                    "SplitLM debug: native length gate bypassed",
                                    getAssetIDByName("Small"),
                                );
                            }

                            // Discord mobile validates content length through
                            // useMessageMaxLength.getMaxMessageLength() before
                            // chatInputSendMessage / MessageActions.sendMessage.
                            // Let the oversized text reach our downstream
                            // splitter; that splitter still uses Discord-sized
                            // 2k/4k chunks.
                            return 1_000_000;
                        },
                    ),
                );

                patchedNativeMaxLengthTargets.add(target);
                logDebug("Patched native getMaxMessageLength gate");
            } catch (error) {
                console.error(
                    "[SplitLargeMessages] failed to patch native max message length",
                    error,
                );
            }
        };

        const patchTooLongGuardMethods = () => {
            const booleanMethods = MESSAGE_COMPOSER_GUARD_METHODS;

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

                const looksLikeMessageLengthTarget =
                    MESSAGE_COMPOSER_SPECIFIC_GUARD_METHODS.some(
                        (method) => typeof target[method] === "function",
                    );

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
                                    const content = direct || draft;

                                    return content.length > getMaxLength()
                                        ? false
                                        : result;
                                },
                            ),
                        );
                    } catch {}
                }

                for (const method of maxLengthMethods) {
                    if (!looksLikeMessageLengthTarget) continue;
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
                                    const content = direct || draft;

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

            patchLiveChatInputRef();
            patchNativeMessageMaxLength();
            patchMessageLengthConstants();
            patchComposerSendTargets();
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

        const restorePendingAutoTextSendTexts = (
            channelId: string,
            file: object,
            sourceText?: string,
            additionalText?: string,
        ) => {
            const pending = pendingAutoTextRestorations.get(file) ?? [];
            const texts = pending.filter(
                (text) =>
                    sourceText === undefined ||
                    !isSameGeneratedText(text, sourceText),
            );
            if (additionalText) texts.unshift(additionalText);
            if (texts.length === 0) {
                pendingAutoTextRestorations.delete(file);
                return;
            }

            const currentDraft = getDraftText(channelId, DraftStore);
            const isGeneratedSourceDraft =
                currentDraft &&
                sourceText !== undefined &&
                isSameGeneratedText(currentDraft, sourceText);
            const allTexts =
                currentDraft &&
                !isGeneratedSourceDraft &&
                !texts.includes(currentDraft)
                    ? [currentDraft, ...texts]
                    : texts;
            const restoredText = allTexts.join("\n\n");

            if (saveDraftText(channelId, restoredText, DraftStore, DraftManager)) {
                pendingAutoTextRestorations.delete(file);
                showFailure(
                    allTexts.length === 1
                        ? "SplitLargeMessages: text restored to the draft; send it again after the upload retry"
                        : `SplitLargeMessages: ${allTexts.length} messages and draft text restored together; separate them before sending`,
                );
                return;
            }

            if (copyText(restoredText)) {
                pendingAutoTextRestorations.delete(file);
                showFailure(
                    allTexts.length === 1
                        ? "SplitLargeMessages: text copied to the clipboard after upload retry"
                        : `SplitLargeMessages: ${allTexts.length} messages and draft text copied together to the clipboard`,
                );
                return;
            }

            pendingAutoTextRestorations.set(file, texts);
            showFailure(
                "SplitLargeMessages: could not restore every suppressed message",
            );
        };

        const stageAutoTextFileForRetry = async (
            channelId: string,
            file: any,
        ): Promise<boolean> => {
            if (
                getChannelUploads(channelId, UploadAttachmentStore).some(
                    (upload) => getUploadFile(upload) === file,
                )
            ) {
                return true;
            }

            if (!originalPromptToUpload) return false;

            try {
                const result = originalPromptToUpload(
                    [file],
                    ChannelStore?.getChannel?.(channelId),
                    0,
                );
                if (result && typeof result.then === "function") {
                    await result;
                }
                return true;
            } catch (error) {
                console.error(
                    "[SplitLargeMessages] failed to restore generated upload for retry",
                    error,
                );
                return false;
            }
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

                // The early composer bridge intentionally lets Discord reach
                // MessageActions.sendMessage with only the first chunk. At
                // this point Discord has already built the full send payload
                // (reply reference, mentions, flags, etc.), so expand the send
                // here instead of fabricating metadata in the composer hook.
                let pendingComposerSend = channelId
                    ? pendingComposerSends.get(channelId)
                    : undefined;

                if (
                    pendingComposerSend &&
                    content === pendingComposerSend.originalContent
                ) {
                    clearTimeout(pendingComposerSend.restoreTimeout);
                    pendingComposerSends.delete(channelId!);
                    inFlightSendKeys.delete(pendingComposerSend.sendKey);
                    pendingComposerSend = undefined;
                }

                if (
                    pendingComposerSend &&
                    content === pendingComposerSend.firstChunk
                ) {
                    showToast(
                        "SplitLM debug: sendMessage reached first chunk",
                        getAssetIDByName("Small"),
                    );
                    clearTimeout(
                        pendingComposerSend.restoreTimeout,
                    );
                    pendingComposerSends.delete(channelId!);
                    activeComposerFirstChunks.set(
                        channelId!,
                        pendingComposerSend.firstChunk,
                    );

                    const chunks =
                        pendingComposerSend.split.chunks;
                    const sendKey = pendingComposerSend.sendKey;
                    const wasQueued =
                        channelQueues.has(channelId!);

                    const queued = enqueueChannelTask(
                        channelId!,
                        async () => {
                            let sent = 0;

                            try {
                                for (
                                    let index = 0;
                                    index < chunks.length;
                                    index++
                                ) {
                                    if (index === 0) {
                                        const firstArgs =
                                            buildChunkArgs(
                                                sendArgs,
                                                channelId!,
                                                chunks[index],
                                                true,
                                            );
                                        await orig(...firstArgs);
                                    } else {
                                        await originalSendMessage(
                                            channelId!,
                                            {
                                                content:
                                                    chunks[index],
                                                tts: false,
                                                invalidEmojis:
                                                    message.invalidEmojis ??
                                                    [],
                                                validNonShortcutEmojis:
                                                    message.validNonShortcutEmojis ??
                                                    [],
                                            },
                                        );
                                    }

                                    sent++;

                                    if (
                                        index <
                                        chunks.length - 1
                                    ) {
                                        await sleep(
                                            getSendDelay(
                                                channelId!,
                                            ),
                                        );
                                    }
                                }
                            } catch (error) {
                                console.error(
                                    "[SplitLargeMessages] composer bridge split send failed",
                                    error,
                                );

                                const unsent =
                                    getUnsentSource(
                                        pendingComposerSend.split,
                                        sent,
                                    );
                                restoreUnsentContent(
                                    channelId!,
                                    unsent,
                                    DraftStore,
                                    DraftManager,
                                );
                                throw error;
                            }
                        },
                        getSendDelay(channelId!),
                    );

                    const cleanupComposerSend = () => {
                        inFlightSendKeys.delete(sendKey);
                        if (
                            activeComposerFirstChunks.get(
                                channelId!,
                            ) ===
                            pendingComposerSend.firstChunk
                        ) {
                            activeComposerFirstChunks.delete(
                                channelId!,
                            );
                        }
                    };

                    void queued.then(
                        cleanupComposerSend,
                        cleanupComposerSend,
                    );

                    if (wasQueued) {
                        showToast(
                            "SplitLargeMessages: queued long message",
                            getAssetIDByName("Small"),
                        );
                    }

                    // Let the composer finish its normal submit/clear flow
                    // immediately rather than waiting for every trailing
                    // chunk. Send failures restore only the unsent source.
                    return undefined;
                }

                if (channelId) {
                    const stagedUploads = getChannelUploads(
                        channelId,
                        UploadAttachmentStore,
                    );
                    const retryUploads = stagedUploads.filter(
                        isGeneratedLongMessageUpload,
                    );
                    const processingUpload = retryUploads.find(
                        (upload) =>
                            getAutoTextState(getUploadFile(upload)) ===
                            "processing",
                    );
                    const pendingRetryUpload =
                        processingUpload ??
                        retryUploads.find(
                            (upload) =>
                                getAutoTextState(getUploadFile(upload)) ===
                                "failed",
                        );

                    if (pendingRetryUpload) {
                        const file = getUploadFile(pendingRetryUpload);
                        const uploadState = getAutoTextState(file);
                        const knownSourceText = autoTextSourceTexts.get(file);
                        const sourceAlreadySent =
                            uploadState === "processing" &&
                            autoTextFirstChunkSent.has(file) &&
                            Boolean(content) &&
                            knownSourceText !== undefined &&
                            isSameGeneratedText(content, knownSourceText);
                        const otherUploads = stagedUploads.filter(
                            (upload) => getUploadFile(upload) !== file,
                        );

                        if (content && !sourceAlreadySent) {
                            const pendingRestorations =
                                pendingAutoTextRestorations.get(file) ?? [];
                            pendingRestorations.push(content);
                            pendingAutoTextRestorations.set(
                                file,
                                pendingRestorations,
                            );
                        }

                        if (otherUploads.length > 0) {
                            const messageAttachments = Array.isArray(
                                message?.attachments,
                            )
                                ? message.attachments
                                : [];
                            const allOtherUploadsInPayload =
                                !otherUploads.some(
                                    isGeneratedLongMessageUpload,
                                ) &&
                                otherUploads.every((upload) =>
                                    messageAttachments.some((attachment: any) =>
                                        attachmentMatchesUpload(
                                            attachment,
                                            upload,
                                        ),
                                    ),
                                );

                            if (!allOtherUploadsInPayload) {
                                if (uploadState !== "processing") {
                                    pendingAutoTextFirstChunkSends.delete(file);
                                }
                                if (!sourceAlreadySent) {
                                    preserveSendTextForAutoUpload(
                                        channelId,
                                        content,
                                    );
                                }
                                if (uploadState !== "processing") {
                                    restorePendingAutoTextSendTexts(
                                        channelId,
                                        file,
                                        knownSourceText,
                                    );
                                }
                                showFailure(
                                    "SplitLargeMessages: other attachments could not be included with the generated text retry; remove them or send them separately first",
                                );
                                return undefined;
                            }

                            const attachmentSend: PendingAutoTextAttachmentSend = {
                                uploads: otherUploads,
                                send: async (
                                    chunk,
                                    includeContent,
                                    excludeUploads,
                                ) => {
                                    const firstArgs = buildChunkArgs(
                                        sendArgs,
                                        channelId,
                                        includeContent ? chunk : "",
                                        true,
                                    );
                                    const { index, message: firstMessage } =
                                        getMessageLocation(firstArgs);

                                    if (!Array.isArray(firstMessage.attachments)) {
                                        return false;
                                    }

                                    const attachments =
                                        firstMessage.attachments.filter(
                                            (attachment: any) =>
                                                !isGeneratedFileAttachment(
                                                    attachment,
                                                    file,
                                                    pendingRetryUpload,
                                                ) &&
                                                !excludeUploads.some((upload) =>
                                                    attachmentMatchesUpload(
                                                        attachment,
                                                        upload,
                                                    ),
                                                ),
                                        );

                                    if (!includeContent && attachments.length === 0) {
                                        return false;
                                    }

                                    firstArgs[index] = {
                                        ...firstMessage,
                                        attachments,
                                    };

                                    await orig(...firstArgs);
                                    return true;
                                },
                            };
                            const pendingSends =
                                pendingAutoTextFirstChunkSends.get(file) ?? {
                                    trailing: [],
                                };

                            if (
                                !autoTextFirstChunkStarted.has(file) &&
                                !pendingSends.first
                            ) {
                                pendingSends.first = attachmentSend;
                            } else {
                                pendingSends.trailing.push(attachmentSend);
                            }
                            pendingAutoTextFirstChunkSends.set(
                                file,
                                pendingSends,
                            );
                        }

                        const preserved = sourceAlreadySent
                            ? "empty"
                            : preserveSendTextForAutoUpload(
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

                        void processAutoTextFile(
                            channelId,
                            file,
                            true,
                            otherUploads.length > 0,
                        ).then(
                            (handled) => {
                                if (handled) return;

                                restorePendingAutoTextSendTexts(
                                    channelId,
                                    file,
                                    autoTextSourceTexts.get(file),
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
                                restorePendingAutoTextSendTexts(
                                    channelId,
                                    file,
                                    autoTextSourceTexts.get(file),
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

                showToast(
                    "SplitLM debug: sendMessage reached oversized text",
                    getAssetIDByName("Small"),
                );

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

                    const forceRetry = getAutoTextState(file) === "failed";

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
        clearLiveComposerAttachTimeouts();

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

        for (const pending of pendingComposerSends.values()) {
            clearTimeout(pending.restoreTimeout);
        }
        pendingComposerSends.clear();
        activeComposerFirstChunks.clear();
        patchedDialogTargets.clear();
        patchedComposerTargets.clear();
        patchedLiveComposerInstances.clear();
        patchedNativeMaxLengthTargets.clear();
        patchedGuardTargets.clear();
        channelQueues.clear();
        inFlightSendKeys.clear();
        restoreMessageLengthConstants();
    },

    settings,
};
