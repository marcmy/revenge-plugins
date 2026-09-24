from pathlib import Path

path = Path("plugins/SplitLargeMessages/src/stableEntry2.ts")
text = path.read_text(encoding="utf-8")

def rep(old, new):
    global text
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"expected one match, got {n}: {old[:100]!r}")
    text = text.replace(old, new, 1)

rep(
'''const patchedComposerTargets = new Set<object>();
const patchedLiveComposerInstances = new Set<object>();
const liveComposerAttachTimeouts = new Set<ReturnType<typeof setTimeout>>();
const patchedGuardTargets = new Set<object>();''',
'''const patchedComposerTargets = new Set<object>();
const patchedLiveComposerInstances = new Set<object>();
const liveComposerAttachTimeouts = new Set<ReturnType<typeof setTimeout>>();
const patchedNativeMaxLengthTargets = new Set<object>();
const patchedGuardTargets = new Set<object>();'''
)

rep(
'''        const UploadAttachmentStore = findByProps("getUploads");
        const DraftStore = findByStoreName("DraftStore") ?? findByProps("getDraft");
        const DraftManager = findByProps("clearDraft", "saveDraft");
        const UploadManager = findByProps("clearAll");''',
'''        const UploadAttachmentStore = findByProps("getUploads");
        const DraftStore = findByStoreName("DraftStore") ?? findByProps("getDraft");
        const DraftManager = findByProps("clearDraft", "saveDraft");
        const UploadManager = findByProps("clearAll");
        const NativeMessageMaxLength =
            findByProps("getMaxMessageLength", "default") ??
            findByProps("getMaxMessageLength");'''
)

rep(
'''        let currentComposerInputRef: any;
        let liveChatInputRefPatchInstalled = false;

        const splitContent = (content: string): MarkdownSplitResult | false =>''',
'''        let currentComposerInputRef: any;
        let liveChatInputRefPatchInstalled = false;
        let nativeMaxLengthDebugShown = false;

        const splitContent = (content: string): MarkdownSplitResult | false =>'''
)

marker = '''        const patchTooLongGuardMethods = () => {
            const booleanMethods = MESSAGE_COMPOSER_GUARD_METHODS;
'''
insert = '''        const patchNativeMessageMaxLength = () => {
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
'''
rep(marker, insert)

rep(
'''            patchLiveChatInputRef();
            patchMessageLengthConstants();
            patchComposerSendTargets();
            patchTooLongGuardMethods();''',
'''            patchLiveChatInputRef();
            patchNativeMessageMaxLength();
            patchMessageLengthConstants();
            patchComposerSendTargets();
            patchTooLongGuardMethods();'''
)

rep(
'''        patchedComposerTargets.clear();
        patchedLiveComposerInstances.clear();
        patchedGuardTargets.clear();''',
'''        patchedComposerTargets.clear();
        patchedLiveComposerInstances.clear();
        patchedNativeMaxLengthTargets.clear();
        patchedGuardTargets.clear();'''
)

path.write_text(text, encoding="utf-8")
