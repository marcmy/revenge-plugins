from pathlib import Path

path = Path("plugins/SplitLargeMessages/src/stableEntry2.ts")
text = path.read_text(encoding="utf-8")

replacements = [
    (
        "const patchedDialogTargets = new Set<object>();\nconst patchedGuardTargets = new Set<object>();",
        "const patchedDialogTargets = new Set<object>();\nconst patchedComposerTargets = new Set<object>();\nconst patchedGuardTargets = new Set<object>();",
    ),
    (
        "        const patchTooLongGuardMethods = () => {\n",
        """        const patchComposerSendTargets = () => {
            const targets = collectTargetsWithMethods(["handleSendMessage"]);
            let patchedCount = 0;

            for (const target of targets) {
                if (patchedComposerTargets.has(target)) continue;
                if (typeof target.handleSendMessage !== "function") continue;

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

                                // The composer rejects oversized messages before
                                // MessageActions.sendMessage is reached on some
                                // Discord builds. Intercept that early guard, but
                                // do not take over when staged uploads could be lost.
                                const uploads = getChannelUploads(
                                    channelId,
                                    UploadAttachmentStore,
                                );
                                if (uploads.length > 0) {
                                    return orig(...args);
                                }

                                const template = findMessagePayload(args);

                                void runStandaloneSplit(
                                    channelId,
                                    content,
                                    "handleSendMessage",
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

        const patchTooLongGuardMethods = () => {
""",
    ),
    (
        "            patchMessageLengthConstants();\n            patchTooLongGuardMethods();",
        "            patchMessageLengthConstants();\n            patchComposerSendTargets();\n            patchTooLongGuardMethods();",
    ),
    (
        "        patchedDialogTargets.clear();\n        patchedGuardTargets.clear();",
        "        patchedDialogTargets.clear();\n        patchedComposerTargets.clear();\n        patchedGuardTargets.clear();",
    ),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match, found {count}: {old[:80]!r}")
    text = text.replace(old, new, 1)

path.write_text(text, encoding="utf-8")
