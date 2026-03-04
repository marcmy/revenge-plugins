import { findByProps } from "@vendetta/metro";
import { before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import settings from "./settings";

type ClipboardSnapshot = {
    text: string;
    at: number;
};

const unpatches: Array<() => void> = [];
let lastClipboardSnapshot: ClipboardSnapshot | undefined;

storage.recoverInDraft ??= true;
storage.recoverOnSend ??= true;
storage.recoveryWindowMs ??= 8000;

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

function looksFlattenedComparedTo(raw: string, current: string): boolean {
    if (!raw || !current) return false;
    if (raw === current) return false;

    const rawMarkdown = hasMarkdownSignals(raw);
    const currentMarkdown = hasMarkdownSignals(current);
    if (rawMarkdown && !currentMarkdown) return true;

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

export default {
    onLoad() {
        patchClipboardReads();
        patchDraftSaves();
        patchSends();
    },
    onUnload() {
        while (unpatches.length) {
            try {
                unpatches.pop()?.();
            } catch { }
        }
        lastClipboardSnapshot = undefined;
    },
    settings,
};
