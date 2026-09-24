from pathlib import Path

path = Path("plugins/SplitLargeMessages/src/stableEntry2.ts")
text = path.read_text(encoding="utf-8")

def rep(old, new, count=1):
    global text
    n = text.count(old)
    if n != count:
        raise SystemExit(f"expected {count} matches, got {n}: {old[:120]!r}")
    text = text.replace(old, new, count)

rep(
'''        let currentComposerInputRef: any;
        let liveChatInputRefPatchInstalled = false;
        let nativeMaxLengthDebugShown = false;

        const splitContent = (content: string): MarkdownSplitResult | false =>''',
'''        let currentComposerInputRef: any;
        let liveChatInputRefPatchInstalled = false;
        let nativeMaxLengthDebugShown = false;

        const syncLiveComposerText = (channelId: string, text: string) => {
            if (!text) return;
            if (SelectedChannelStore?.getChannelId?.() !== channelId) return;

            const target = currentComposerInputRef?.current;
            if (!target) return;

            try {
                if (typeof target.handleTextChanged === "function") {
                    target.handleTextChanged(text);
                    return;
                }

                if (typeof target.setText === "function") {
                    target.setText(text);
                }
            } catch (error) {
                console.error(
                    "[SplitLargeMessages] failed to sync restored draft into the live composer",
                    error,
                );
            }
        };

        const restoreAndSyncUnsentContent = (
            channelId: string,
            text: string,
        ) => {
            restoreUnsentContent(
                channelId,
                text,
                DraftStore,
                DraftManager,
            );

            if (getDraftText(channelId, DraftStore) === text) {
                syncLiveComposerText(channelId, text);
            }
        };

        const splitContent = (content: string): MarkdownSplitResult | false =>'''
)

# Fix all ordinary unsent restorations inside onLoad to update the visible composer
# once DraftStore restoration succeeds.
rep(
'''                    restoreUnsentContent(
                        channelId,
                        unsent,
                        DraftStore,
                        DraftManager,
                    );''',
'''                    restoreAndSyncUnsentContent(
                        channelId,
                        unsent,
                    );''',
2
)

rep(
'''                restoreUnsentContent(
                    pending.channelId,
                    pending.originalContent,
                    DraftStore,
                    DraftManager,
                );''',
'''                restoreAndSyncUnsentContent(
                    pending.channelId,
                    pending.originalContent,
                );'''
)

rep(
'''                                restoreUnsentContent(
                                    channelId!,
                                    unsent,
                                    DraftStore,
                                    DraftManager,
                                );''',
'''                                restoreAndSyncUnsentContent(
                                    channelId!,
                                    unsent,
                                );'''
)

# Reuse Discord's full original argument vector for every intercepted chunk.
# Current mobile sendMessage uses channelId, parsedMessage, undefined, options;
# the old 2-argument trailing calls fail immediately on chunk 2+.
rep(
'''                                    if (index === 0) {
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
                                    }''',
'''                                    const chunkArgs =
                                        buildChunkArgs(
                                            sendArgs,
                                            channelId!,
                                            chunks[index],
                                            index === 0,
                                        );

                                    if (
                                        index > 0 &&
                                        chunkArgs.length > 3 &&
                                        chunkArgs[3] &&
                                        typeof chunkArgs[3] === "object"
                                    ) {
                                        chunkArgs[3] = {
                                            ...chunkArgs[3],
                                            attachmentsToUpload: [],
                                        };
                                    }

                                    await orig(...chunkArgs);'''
)

rep(
'''                            if (index === 0) {
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
                            }''',
'''                            const chunkArgs = buildChunkArgs(
                                sendArgs,
                                channelId,
                                chunks[index],
                                index === 0,
                            );

                            if (
                                index > 0 &&
                                chunkArgs.length > 3 &&
                                chunkArgs[3] &&
                                typeof chunkArgs[3] === "object"
                            ) {
                                chunkArgs[3] = {
                                    ...chunkArgs[3],
                                    attachmentsToUpload: [],
                                };
                            }

                            await orig(...chunkArgs);'''
)

# Internal non-intercepted send helpers also need the current mobile call shape.
rep(
'''                        await originalSendMessage(channelId, payload);''',
'''                        await originalSendMessage(
                            channelId,
                            payload,
                            undefined,
                            { attachmentsToUpload: [] },
                        );'''
)

rep(
'''                            await originalSendMessage(channelId, {
                                content: chunks[index],
                                tts: false,
                                invalidEmojis: [],
                                validNonShortcutEmojis: [],
                            });''',
'''                            await originalSendMessage(
                                channelId,
                                {
                                    content: chunks[index],
                                    tts: false,
                                    invalidEmojis: [],
                                    validNonShortcutEmojis: [],
                                },
                                undefined,
                                { attachmentsToUpload: [] },
                            );'''
)

path.write_text(text, encoding="utf-8")
