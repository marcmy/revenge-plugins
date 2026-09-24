import { findByName, findByStoreName } from "@vendetta/metro";
import { ReactNative } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";

// Legacy Revenge port of the modern RealMoji renderer used by contrabag's
// Revenge Next plugin. Original RealMoji concept/implementation credits:
// redstonekasi and Purple Eye.
//
// The important change from the older legacy RealMoji is that we transform
// every Freemoji CDN link in-place instead of assuming all fake emoji URLs
// are grouped at the end of the message.

const emojiRegex =
    /https:\/\/cdn\.discordapp\.com\/emojis\/(\d+)\.(png|webp|gif)(?:\?|$)/i;

const MAX_JUMBO_EMOJIS = 27;
const unicodeEmojiSequenceRegex =
    /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)/gu;

const EmojiStore = findByStoreName("EmojiStore");
const RowManager = findByName("RowManager");

let unpatch: (() => void) | undefined;

function getEmojiInfo(url: string) {
    const match = url.match(emojiRegex);
    if (!match) return;

    const id = match[1];
    const extension = match[2].toLowerCase();

    let parsedUrl: URL | undefined;
    try {
        parsedUrl = new URL(url);
    } catch {}

    let emoji: any;
    try {
        emoji = EmojiStore?.getCustomEmojiById?.(id);
    } catch {}

    const name =
        emoji?.name ??
        parsedUrl?.searchParams.get("name") ??
        "<realmoji>";

    const animated =
        extension === "gif" ||
        parsedUrl?.searchParams.get("animated") === "true" ||
        emoji?.animated === true;

    const coreUrl =
        `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}`;

    const src = `${coreUrl}?size=128`;

    return {
        id,
        name,
        src,
        frozenSrc: src.replace(".gif", ".webp"),
    };
}

function createCustomEmoji(url: string, jumbo: boolean) {
    const info = getEmojiInfo(url);
    if (!info) return;

    return {
        id: info.id,
        alt: info.name,
        src: info.src,
        frozenSrc: info.frozenSrc,
        type: "customEmoji",
        jumboable: jumbo ? true : undefined,
    };
}

function isWhitespaceText(item: any) {
    return (
        item?.type === "text" &&
        typeof item?.content === "string" &&
        item.content.trim() === ""
    );
}

function trimOuterWhitespace(content: any[]) {
    while (content.length && isWhitespaceText(content[0])) content.shift();
    while (content.length && isWhitespaceText(content[content.length - 1])) {
        content.pop();
    }

    if (
        content[0]?.type === "text" &&
        typeof content[0]?.content === "string"
    ) {
        content[0].content = content[0].content.trimStart();
    }

    const last = content[content.length - 1];
    if (last?.type === "text" && typeof last?.content === "string") {
        last.content = last.content.trimEnd();
    }
}

function countUnicodeEmojiText(value: string): number | null {
    if (!value.trim()) return 0;

    const matches = value.match(unicodeEmojiSequenceRegex) ?? [];
    const remainder = value.replace(unicodeEmojiSequenceRegex, "");

    return remainder.trim() === "" && matches.length > 0
        ? matches.length
        : null;
}

function getEmojiOnlyCount(content: any[]): number | null {
    let hasFreemojiLink = false;

    const countNode = (node: any): number | null => {
        if (node == null || node === false) return 0;

        if (Array.isArray(node)) {
            let count = 0;

            for (const child of node) {
                const childCount = countNode(child);
                if (childCount == null) return null;
                count += childCount;
            }

            return count;
        }

        if (typeof node === "string") return countUnicodeEmojiText(node);
        if (typeof node !== "object") return null;

        if (
            node.type === "link" &&
            typeof node.target === "string" &&
            emojiRegex.test(node.target)
        ) {
            hasFreemojiLink = true;
            return 1;
        }

        if (node.type === "emoji" || node.type === "customEmoji") return 1;

        if (node.type === "text" && typeof node.content === "string") {
            return countUnicodeEmojiText(node.content);
        }

        if (Array.isArray(node.content)) return countNode(node.content);

        return null;
    };

    const count = countNode(content);
    return hasFreemojiLink && count != null && count > 0 ? count : null;
}

function setEmojiJumboable(content: any[]) {
    const visit = (node: any) => {
        if (Array.isArray(node)) {
            for (const child of node) visit(child);
            return;
        }

        if (!node || typeof node !== "object") return;

        if (node.type === "emoji" || node.type === "customEmoji") {
            node.jumboable = true;
        }

        if (Array.isArray(node.content)) visit(node.content);
    };

    visit(content);
}

function convertLinks(content: any[]) {
    if (!Array.isArray(content)) return false;

    const emojiOnlyCount = getEmojiOnlyCount(content);
    const jumbo =
        emojiOnlyCount != null &&
        emojiOnlyCount <= MAX_JUMBO_EMOJIS;

    let converted = false;

    for (let i = 0; i < content.length; i++) {
        const item = content[i];

        if (
            item?.type !== "link" ||
            typeof item?.target !== "string" ||
            !emojiRegex.test(item.target)
        ) {
            continue;
        }

        const emoji = createCustomEmoji(item.target, jumbo);
        if (!emoji) continue;

        content[i] = emoji;
        converted = true;
    }

    if (converted) {
        trimOuterWhitespace(content);
        if (jumbo) setEmojiJumboable(content);
    }

    return converted;
}

function removeEmojiEmbeds(message: any) {
    if (!Array.isArray(message?.embeds)) return;

    message.embeds = message.embeds.filter((embed: any) => {
        const url = embed?.url ?? embed?.image?.url;

        return !(
            embed?.type === "image" &&
            typeof url === "string" &&
            emojiRegex.test(url)
        );
    });
}

function clearEmbedLayout(message: any) {
    message.useAttachmentGridLayout = false;
    message.useAttachmentUploadPreview = false;
}

function convertEmbedOnlyMessage(message: any) {
    if (
        !Array.isArray(message?.content) ||
        message.content.length !== 0 ||
        !Array.isArray(message?.embeds)
    ) {
        return false;
    }

    const urls: string[] = [];

    for (const embed of message.embeds) {
        const url = embed?.url ?? embed?.image?.url;

        if (
            embed?.type === "image" &&
            typeof url === "string" &&
            emojiRegex.test(url)
        ) {
            urls.push(url);
        }
    }

    if (!urls.length) return false;

    const newContent: any[] = [];
    const jumbo = urls.length <= MAX_JUMBO_EMOJIS;

    for (const url of urls) {
        const emoji = createCustomEmoji(url, jumbo);
        if (!emoji) continue;

        if (newContent.length) {
            newContent.push({
                content: " ",
                type: "text",
                jumboable: jumbo ? true : undefined,
            });
        }

        newContent.push(emoji);
    }

    if (!newContent.length) return false;

    message.content = newContent;
    removeEmojiEmbeds(message);
    clearEmbedLayout(message);
    return true;
}

function processRow(row: any) {
    if (!row?.message) return;

    // Native updateRows uses type=1 for message rows. RowManager.generate
    // fallback rows may omit the field, so only reject an explicit non-message.
    if (row.type != null && row.type !== 1) return;

    const message = row.message;

    if (convertEmbedOnlyMessage(message)) return;

    if (convertLinks(message.content)) {
        removeEmojiEmbeds(message);
        clearEmbedLayout(message);
    }
}

function processRows(rows: any[]) {
    if (!Array.isArray(rows)) return;

    for (const row of rows) {
        try {
            processRow(row);
        } catch (error) {
            console.error("[RealMoji] Failed to process row", error);
        }
    }
}

function patchRows() {
    const DCDChatManager = (ReactNative as any)?.NativeModules?.DCDChatManager;

    if (DCDChatManager?.updateRows) {
        return before("updateRows", DCDChatManager, (args: any[]) => {
            try {
                if (typeof args[1] !== "string") return;

                const rows = JSON.parse(args[1]);
                processRows(rows);
                args[1] = JSON.stringify(rows);
            } catch (error) {
                console.error("[RealMoji] updateRows error", error);
            }
        });
    }

    if (RowManager?.prototype?.generate) {
        return after(
            "generate",
            RowManager.prototype,
            (_args: any[], row: any) => {
                try {
                    processRow(row);
                } catch (error) {
                    console.error("[RealMoji] RowManager fallback error", error);
                }
            },
        );
    }

    console.error("[RealMoji] No supported chat row renderer found");
    return () => {};
}

export default {
    onLoad() {
        unpatch = patchRows();
    },

    onUnload() {
        try {
            unpatch?.();
        } catch {}

        unpatch = undefined;
    },
};
