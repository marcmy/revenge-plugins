import { findByProps, findByStoreName } from "@vendetta/metro";
import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import settings from "./settings";

let unpatch: (() => void) | undefined;
storage.splitOnWords ??= false;

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function intoChunks(content: string, maxChunkLength: number): string[] | false {
    const chunks = [] as string[];

    if (!storage.splitOnWords) {
        chunks.push(
            content.split("\n").reduce((currentChunk, paragraph) => {
                if (currentChunk.length + paragraph.length + 2 > maxChunkLength) {
                    chunks.push(currentChunk);
                    return paragraph + "\n";
                }
                if (!currentChunk) return paragraph + "\n";
                return currentChunk + paragraph + "\n";
            }, "")
        );
    }

    if (chunks.length && !chunks.some(chunk => chunk.length > maxChunkLength)) {
        return chunks.map(c => c.trim());
    }

    chunks.length = 0;
    chunks.push(
        content.split(" ").reduce((currentChunk, word) => {
            if (currentChunk.length + word.length + 2 > maxChunkLength) {
                chunks.push(currentChunk);
                return word + " ";
            }
            if (!currentChunk) return word + " ";
            return currentChunk + word + " ";
        }, "")
    );

    if (chunks.some(chunk => chunk.length > maxChunkLength)) return false;
    return chunks.map(c => c.trim());
}

export default {
    onLoad() {
        const ChannelStore = findByStoreName("ChannelStore");
        const UserStore = findByStoreName("UserStore");
        const MessageActions = findByProps("sendMessage", "editMessage");
        const Constants = findByProps("MAX_MESSAGE_LENGTH");

        const originalSendMessage = MessageActions.sendMessage.bind(MessageActions);
        const sendChunk = async (
            channelId: string,
            message: { [key: string]: any },
            content: string
        ) => {
            const chunkMessage = {
                invalidEmojis: message.invalidEmojis,
                validNonShortcutEmojis: message.validNonShortcutEmojis,
                tts: false,
                content,
            };

            if (typeof MessageActions._sendMessage === "function") {
                await MessageActions._sendMessage(channelId, chunkMessage, {});
                return;
            }

            await originalSendMessage(channelId, chunkMessage);
        };

        const getMaxLength = () => UserStore.getCurrentUser()?.premiumType === 2 ? 4000 : 2000;

        if (Constants) {
            Constants.MAX_MESSAGE_LENGTH = 2 ** 30;
            Constants.MAX_MESSAGE_LENGTH_PREMIUM = 2 ** 30;
        }

        unpatch?.();
        unpatch = before("sendMessage", MessageActions, args => {
            const [channelId, message] = args as [string, { content?: string; [key: string]: any }];
            const content = message?.content;

            if (!content || content.length <= getMaxLength()) return;

            const chunks = intoChunks(content, getMaxLength());
            if (!chunks) {
                message.content = "";
                showToast("Failed to split message", getAssetIDByName("Small"));
                return;
            }

            const nonEmptyChunks = chunks.filter(chunk => chunk.length > 0);
            if (!nonEmptyChunks.length) {
                message.content = "";
                showToast("Failed to split message", getAssetIDByName("Small"));
                return;
            }

            message.content = nonEmptyChunks.shift() ?? "";

            const channel = ChannelStore.getChannel(channelId);
            (async () => {
                for (const chunk of nonEmptyChunks) {
                    await sleep(Math.max((channel?.rateLimitPerUser ?? 0) * 1000, 1000));
                    await sendChunk(channelId, message, chunk);
                }
            })();
        });
    },
    onUnload: () => {
        unpatch?.();
        unpatch = undefined;

        const Constants = findByProps("MAX_MESSAGE_LENGTH");
        if (Constants) {
            Constants.MAX_MESSAGE_LENGTH = 2000;
            Constants.MAX_MESSAGE_LENGTH_PREMIUM = 4000;
        }
    },
    settings,
};
