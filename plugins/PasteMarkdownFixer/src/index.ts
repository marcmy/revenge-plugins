import { findByProps } from "@vendetta/metro";
import { React } from "@vendetta/metro/common";
import { before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import settings from "./settings";

type ClipboardSnapshot = {
    text: string;
    at: number;
};

const unpatches: Array<() => void> = [];
let lastClipboardSnapshot: ClipboardSnapshot | undefined;
let clipboardPollInterval: ReturnType<typeof setInterval> | undefined;

storage.recoverInDraft ??= true;
storage.recoverOnSend ??= true;
storage.recoverInComposer ??= true;
storage.recoveryWindowMs ??= 180000;

function now() {
    return Date.now();
}

function hasMarkdownSignals(text: string): boolean {
    return (
        /(^|\n)\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(text)
        || /(^|\n)\s*#{1,6}\s+/.test(text)
        || /```/.test(text)
        || /(^|\n)\s*>/.test(text)
        || /\*\*[^*\n]+\*\*/.test(text)
        || /`[^`\n]+`/.test(text)
    );
}

function flattenMarkdownLike(text: string): string {
    return text
        .replace(/```[\w-]*\n?/g, "")
        .replace(/```/g, "")
        .replace(/(^|\n)\s*#{1,6}\s+/g, "$1")
        .replace(/(^|\n)\s*(?:[-*+]\s+|\d+[.)]\s+)/g, "$1")
        .replace(/\*\*([^*\n]+)\*\*/g, "$1")
        .replace(/`([^`\n]+)`/g, "$1")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function looksFlattenedComparedTo(raw: string, current: string): boolean {
    if (!raw || !current) return false;
    if (raw === current) return false;

    const rawMarkdown = hasMarkdownSignals(raw);
    const currentMarkdown = hasMarkdownSignals(current);
    if (rawMarkdown && !currentMarkdown) return true;

    const flattenedRaw = flattenMarkdownLike(raw);
    if (flattenedRaw && current) {
        const a = flattenedRaw.replace(/\s+/g, " ").trim();
        const b = current.replace(/\s+/g, " ").trim();
        if (a === b || a.includes(b) || b.includes(a)) return true;
    }

    const rawLines = raw.split("\n").length;
    const currentLines = current.split("\n").length;
    if (rawLines - currentLines >= 2) return true;

    return false;
}

function maybeRecoverFromClipboard(current: string): string {
    const snapshot = lastClipboardSnapshot;
    if (!snapshot) return current;

    const windowMs = typeof storage.recoveryWindowMs === "number"
        ? storage.recoveryWindowMs
        : 8000;
    if (now() - snapshot.at > Math.max(500, windowMs)) return current;

    if (!looksFlattenedComparedTo(snapshot.text, current)) return current;
    return snapshot.text;
}

function findTextArgIndex(args: any[]): number {
    let fallback = -1;
    for (let i = args.length - 1; i >= 0; i--) {
        const value = args[i];
        if (typeof value !== "string") continue;
        if (i === 0 && /^\d+$/.test(value)) continue;
        if (!value.length) continue;
        if (value.includes("\n") || value.length > 80) return i;
        fallback = i;
    }
    return fallback;
}

function isLikelyComposerInputProps(props: any): boolean {
    if (!props || typeof props !== "object") return false;
    if (typeof props.onChangeText !== "function" && typeof props.onChange !== "function") return false;
    if (props.multiline !== true) return false;

    const placeholder = typeof props.placeholder === "string" ? props.placeholder.toLowerCase() : "";
    const maxLength = typeof props.maxLength === "number" ? props.maxLength : 0;
    const lines = typeof props.numberOfLines === "number" ? props.numberOfLines : 0;

    if (placeholder.includes("message") || placeholder.includes("send")) return true;
    if (maxLength >= 1000) return true;
    if (lines > 1) return true;
    return false;
}

function wrapComposerProps(props: Record<string, any>): Record<string, any> {
    if (!storage.recoverInComposer) return props;
    if ((props as any).__pasteMarkdownFixerWrapped) return props;
    if (!isLikelyComposerInputProps(props)) return props;

    const wrapped = { ...props, __pasteMarkdownFixerWrapped: true };

    if (typeof props.onChangeText === "function") {
        const originalOnChangeText = props.onChangeText;
        wrapped.onChangeText = (text: string) => {
            const recovered = typeof text === "string" ? maybeRecoverFromClipboard(text) : text;
            return originalOnChangeText(recovered);
        };
    }

    if (typeof props.onChange === "function") {
        const originalOnChange = props.onChange;
        wrapped.onChange = (event: any) => {
            try {
                const text = event?.nativeEvent?.text;
                if (typeof text === "string") {
                    const recovered = maybeRecoverFromClipboard(text);
                    if (recovered !== text) {
                        event = {
                            ...event,
                            nativeEvent: { ...(event?.nativeEvent ?? {}), text: recovered },
                        };
                    }
                }
            } catch { }

            return originalOnChange(event);
        };
    }

    return wrapped;
}

function patchClipboardReads() {
    const clipboard = findByProps("setString", "getString", "hasString");
    if (!clipboard || typeof clipboard.getString !== "function") return;

    unpatches.push(
        instead("getString", clipboard, (args, orig) => {
            const result = (orig as (...callArgs: any[]) => any)(...(args as any[]));

            if (result && typeof result.then === "function") {
                return result.then((text: string) => {
                    if (typeof text === "string" && text.length > 0) {
                        lastClipboardSnapshot = { text, at: now() };
                    }
                    return text;
                });
            }

            if (typeof result === "string" && result.length > 0) {
                lastClipboardSnapshot = { text: result, at: now() };
            }

            return result;
        }),
    );

    const poll = () => {
        try {
            const result = clipboard.getString();
            if (!result || typeof result.then !== "function") return;
            void result.then((text: string) => {
                if (typeof text !== "string" || text.length === 0) return;
                if (lastClipboardSnapshot?.text === text) return;
                lastClipboardSnapshot = { text, at: now() };
            }).catch(() => { });
        } catch { }
    };

    poll();
    clipboardPollInterval = setInterval(poll, 1500);
}

function patchDraftSaves() {
    const DraftManager = findByProps("saveDraft");
    if (!DraftManager || typeof DraftManager.saveDraft !== "function") return;

    unpatches.push(
        before("saveDraft", DraftManager, (args) => {
            if (!storage.recoverInDraft) return;
            const index = findTextArgIndex(args as any[]);
            if (index < 0) return;

            const current = (args as any[])[index];
            if (typeof current !== "string" || !current.length) return;

            const recovered = maybeRecoverFromClipboard(current);
            if (recovered !== current) {
                (args as any[])[index] = recovered;
            }
        }),
    );
}

function patchSends() {
    const MessageActions = findByProps("sendMessage", "editMessage");
    if (!MessageActions || typeof MessageActions.sendMessage !== "function") return;

    unpatches.push(
        before("sendMessage", MessageActions, (args) => {
            if (!storage.recoverOnSend) return;

            for (const value of args as any[]) {
                if (!value || typeof value !== "object") continue;
                if (typeof value.content !== "string" || !value.content.length) continue;

                const recovered = maybeRecoverFromClipboard(value.content);
                if (recovered !== value.content) {
                    value.content = recovered;
                }
                return;
            }
        }),
    );
}

function patchComposerTextInputs() {
    const jsxRuntime = findByProps("jsx", "jsxs");
    if (jsxRuntime) {
        for (const method of ["jsx", "jsxs"] as const) {
            if (typeof jsxRuntime[method] !== "function") continue;
            unpatches.push(
                instead(method, jsxRuntime, (args, orig) => {
                    const [type, props, ...rest] = args as [any, Record<string, any>, ...any[]];
                    const name = String(type?.displayName ?? type?.name ?? type ?? "");
                    if (name.includes("TextInput") && props && typeof props === "object") {
                        return (orig as (...callArgs: any[]) => any)(type, wrapComposerProps(props), ...rest);
                    }

                    return (orig as (...callArgs: any[]) => any)(...args);
                }),
            );
        }
    }

    if (React && typeof React.createElement === "function") {
        unpatches.push(
            instead("createElement", React, (args, orig) => {
                const [type, props, ...children] = args as [any, Record<string, any>, ...any[]];
                const name = String(type?.displayName ?? type?.name ?? type ?? "");
                if (name.includes("TextInput") && props && typeof props === "object") {
                    return (orig as (...callArgs: any[]) => any)(type, wrapComposerProps(props), ...children);
                }

                return (orig as (...callArgs: any[]) => any)(...args);
            }),
        );
    }
}

export default {
    onLoad() {
        patchClipboardReads();
        patchComposerTextInputs();
        patchDraftSaves();
        patchSends();
    },
    onUnload() {
        while (unpatches.length) {
            try {
                unpatches.pop()?.();
            } catch { }
        }
        if (clipboardPollInterval) {
            clearInterval(clipboardPollInterval);
            clipboardPollInterval = undefined;
        }
        lastClipboardSnapshot = undefined;
    },
    settings,
};
