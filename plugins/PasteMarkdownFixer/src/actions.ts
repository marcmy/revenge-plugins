import { findByProps, findByStoreName } from "@vendetta/metro";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

function toast(message: string) {
    showToast(message, getAssetIDByName("Small"));
}

function getSelectedChannelId(): string | undefined {
    try {
        const SelectedChannelStore = findByStoreName("SelectedChannelStore");
        const id = SelectedChannelStore?.getChannelId?.();
        return typeof id === "string" && id.length > 0 ? id : undefined;
    } catch {
        return undefined;
    }
}

function getDraftText(channelId: string): string {
    const DraftStore = findByProps("getDraft");
    if (!DraftStore?.getDraft) return "";

    try {
        const byType = DraftStore.getDraft(channelId, 0);
        if (typeof byType === "string") return byType;
    } catch { }

    try {
        const basic = DraftStore.getDraft(channelId);
        if (typeof basic === "string") return basic;
    } catch { }

    return "";
}

function saveDraftText(channelId: string, text: string): boolean {
    const DraftManager = findByProps("clearDraft", "saveDraft");
    if (!DraftManager?.saveDraft) return false;

    const attempts = [
        () => DraftManager.saveDraft(channelId, 0, text),
        () => DraftManager.saveDraft(channelId, text, 0),
        () => DraftManager.saveDraft(channelId, text),
    ];

    for (const attempt of attempts) {
        try {
            attempt();
            if (getDraftText(channelId) === text) return true;
        } catch { }
    }

    return false;
}

function clearDraft(channelId: string) {
    const DraftManager = findByProps("clearDraft", "saveDraft");
    try { DraftManager?.clearDraft?.(channelId, 0); } catch { }
    try { DraftManager?.clearDraft?.(channelId); } catch { }
}

function isExistingListLine(line: string): boolean {
    return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}

function isLikelyHeadingLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return (
        /:\s*$/.test(trimmed)
        || /^#{1,6}\s+/.test(trimmed)
        || /^\*\*.+\*\*$/.test(trimmed)
    );
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

export function normalizeDraftMarkdown(content: string): string {
    const lines = content.split("\n");
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if ((line.match(/```/g) ?? []).length % 2 === 1) {
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

export function fixCurrentDraft(): void {
    const channelId = getSelectedChannelId();
    if (!channelId) {
        toast("No active channel selected");
        return;
    }

    const current = getDraftText(channelId);
    if (!current) {
        toast("Draft is empty");
        return;
    }

    const normalized = normalizeDraftMarkdown(current);
    if (normalized === current) {
        toast("No markdown fix needed");
        return;
    }

    if (saveDraftText(channelId, normalized)) {
        toast("Draft markdown fixed");
    } else {
        toast("Failed to update draft");
    }
}

export function fixAndSendCurrentDraft(): void {
    const channelId = getSelectedChannelId();
    if (!channelId) {
        toast("No active channel selected");
        return;
    }

    const current = getDraftText(channelId);
    if (!current) {
        toast("Draft is empty");
        return;
    }

    const normalized = normalizeDraftMarkdown(current);
    const MessageActions = findByProps("sendMessage", "editMessage");
    if (!MessageActions || typeof MessageActions.sendMessage !== "function") {
        toast("Send API unavailable");
        return;
    }

    try {
        MessageActions.sendMessage(channelId, { content: normalized });
        clearDraft(channelId);
        toast("Sent normalized draft");
    } catch {
        toast("Failed to send draft");
    }
}
