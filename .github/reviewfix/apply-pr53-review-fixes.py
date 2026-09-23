from pathlib import Path

path = Path("plugins/SplitLargeMessages/src/stableEntry2.ts")
text = path.read_text(encoding="utf-8")

def replace_once(old: str, new: str):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match, got {count}: {old[:120]!r}")
    text = text.replace(old, new, 1)

replace_once(
    'const channelQueues = new Map<string, Promise<void>>();\n'
    'const inFlightSendKeys = new Set<string>();',
    'const channelQueues = new Map<string, Promise<void>>();\n'
    'const inFlightSendKeys = new Set<string>();\n'
    'const pendingComposerSends = new Map<string, PendingComposerSend>();\n'
    'const activeComposerFirstChunks = new Map<string, string>();',
)

replace_once(
    '''type PendingAutoTextSends = {
    first?: PendingAutoTextAttachmentSend;
    trailing: PendingAutoTextAttachmentSend[];
};''',
    '''type PendingAutoTextSends = {
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
};''',
)

start = text.index('        const patchComposerSendTargets = () => {')
end = text.index('        const patchTooLongGuardMethods = () => {', start)
composer_block = '''        const rewriteComposerContent = (
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

'''
text = text[:start] + composer_block + text[end:]

needle = '''                const channelId = resolveSendChannelId(
                    SelectedChannelStore,
                    sendArgs,
                );

                if (channelId) {'''

bridge = '''                const channelId = resolveSendChannelId(
                    SelectedChannelStore,
                    sendArgs,
                );

                // The early composer bridge intentionally lets Discord reach
                // MessageActions.sendMessage with only the first chunk. At
                // this point Discord has already built the full send payload
                // (reply reference, mentions, flags, etc.), so expand the send
                // here instead of fabricating metadata in the composer hook.
                const pendingComposerSend = channelId
                    ? pendingComposerSends.get(channelId)
                    : undefined;

                if (
                    pendingComposerSend &&
                    content === pendingComposerSend.firstChunk
                ) {
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

                if (channelId) {'''

replace_once(needle, bridge)

# The same stale-draft preference existed in the passive guard/dialog
# fallbacks. Prefer submitted content there too.
stale = '''                                    const content =
                                        direct.length >= draft.length
                                            ? direct
                                            : draft;'''
text = text.replace(stale, '                                    const content = direct || draft;', 2)

replace_once(
    '''        patchedDialogTargets.clear();
        patchedComposerTargets.clear();
        patchedGuardTargets.clear();
        channelQueues.clear();
        inFlightSendKeys.clear();''',
    '''        for (const pending of pendingComposerSends.values()) {
            clearTimeout(pending.restoreTimeout);
        }
        pendingComposerSends.clear();
        activeComposerFirstChunks.clear();
        patchedDialogTargets.clear();
        patchedComposerTargets.clear();
        patchedGuardTargets.clear();
        channelQueues.clear();
        inFlightSendKeys.clear();''',
)

path.write_text(text, encoding="utf-8")
