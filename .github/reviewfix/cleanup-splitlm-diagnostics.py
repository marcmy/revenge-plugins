from pathlib import Path

path = Path("plugins/SplitLargeMessages/src/stableEntry2.ts")
text = path.read_text(encoding="utf-8")

def rep(old: str, new: str, count: int = 1):
    global text
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"expected {count} match(es), got {actual}: {old[:120]!r}")
    text = text.replace(old, new, count)

rep(
'''        let currentComposerInputRef: any;
        let liveChatInputRefPatchInstalled = false;
        let nativeMaxLengthDebugShown = false;
''',
'''        let currentComposerInputRef: any;
        let liveChatInputRefPatchInstalled = false;
'''
)

rep(
'''                            if (draft.length <= result) {
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
''',
'''                            if (draft.length <= result) {
                                return result;
                            }
'''
)

rep(
'''                            if (!pending) {
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
''',
'''                            if (!pending) {
                                return;
                            }
'''
)

rep(
'''                    showToast(
                        "SplitLM debug: sendMessage reached first chunk",
                        getAssetIDByName("Small"),
                    );
''',
''
)

rep(
'''                showToast(
                    "SplitLM debug: sendMessage reached oversized text",
                    getAssetIDByName("Small"),
                );

''',
''
)

if "SplitLM debug:" in text:
    raise SystemExit("temporary SplitLM debug toast remains after cleanup")
if "nativeMaxLengthDebugShown" in text:
    raise SystemExit("nativeMaxLengthDebugShown remains after cleanup")

path.write_text(text, encoding="utf-8")
