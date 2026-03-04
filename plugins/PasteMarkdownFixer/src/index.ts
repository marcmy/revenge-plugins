import { findByProps } from "@vendetta/metro";
import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import settings from "./settings";

const unpatches: Array<() => void> = [];

storage.fixListsInDraft ??= true;
storage.fixListsOnSend ??= true;

function countFenceTokens(line: string): number {
    return (line.match(/```/g) ?? []).length;
}

function isExistingListLine(line: string): boolean {
    return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}

function isLikelyHeadingLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return /:\s*$/.test(trimmed) || /^#{1,6}\s+/.test(trimmed) || /^\*\*.+\*\*$/.test(trimmed);
}

function isLikelyListItemLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.length > 120) return false;
    if (isExistingListLine(trimmed)) return false;
    if (/^#{1,6}\s+/.test(trimmed)) return false;
    if (/^```/.test(trimmed)) return false;
    return true;
}

function normalizePlainLists(content: string): string {
    const lines = content.split("\n");
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceTokens = countFenceTokens(line);
        if (fenceTokens % 2 === 1) {
            inFence = !inFence;
        }
        if (inFence) continue;
        if (!isLikelyHeadingLine(line)) continue;

        let start = i + 1;
        while (start < lines.length && lines[start].trim() === "") start++;
        if (start >= lines.length) continue;

        let end = start;
        while (end < lines.length) {
            const current = lines[end];
            if (!current.trim()) break;
            if (!isLikelyListItemLine(current)) break;
            end++;
        }

        if (end - start < 2) continue;

        for (let j = start; j < end; j++) {
            const indent = lines[j].match(/^\s*/)?.[0] ?? "";
            lines[j] = `${indent}- ${lines[j].trimStart()}`;
        }

        i = end - 1;
    }

    return lines.join("\n");
}

function findDraftTextArgIndex(args: any[]): number {
    let fallback = -1;
    for (let i = args.length - 1; i >= 0; i--) {
        const value = args[i];
        if (typeof value !== "string") continue;
        if (i === 0 && /^\d+$/.test(value)) continue;
        if (value.length === 0) continue;
        if (value.includes("\n") || value.includes(":") || value.length > 80) return i;
        fallback = i;
    }

    return fallback;
}

function patchSaveDraft() {
    const DraftManager = findByProps("saveDraft");
    if (!DraftManager || typeof DraftManager.saveDraft !== "function") return;

    unpatches.push(
        before("saveDraft", DraftManager, (args) => {
            if (!storage.fixListsInDraft) return;
            const index = findDraftTextArgIndex(args as any[]);
            if (index < 0) return;

            const original = (args as any[])[index];
            if (typeof original !== "string" || !original.length) return;
            const normalized = normalizePlainLists(original);
            if (normalized !== original) {
                (args as any[])[index] = normalized;
            }
        }),
    );
}

function patchSendMessage() {
    const MessageActions = findByProps("sendMessage", "editMessage");
    if (!MessageActions || typeof MessageActions.sendMessage !== "function") return;

    unpatches.push(
        before("sendMessage", MessageActions, (args) => {
            if (!storage.fixListsOnSend) return;

            for (const value of args as any[]) {
                if (!value || typeof value !== "object") continue;
                if (typeof value.content !== "string") continue;

                const normalized = normalizePlainLists(value.content);
                if (normalized !== value.content) {
                    value.content = normalized;
                }
                return;
            }
        }),
    );
}

export default {
    onLoad() {
        patchSaveDraft();
        patchSendMessage();
    },
    onUnload() {
        while (unpatches.length) {
            try {
                unpatches.pop()?.();
            } catch { }
        }
    },
    settings,
};
