import { findByProps, findByStoreName } from "@vendetta/metro";
import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import basePlugin from "./index";
import { splitMarkdownMessage } from "./markdownSplitter";

let unpatchMarkdownSend: (() => void) | undefined;
let unpatchMarkdownUpload: (() => void) | undefined;
let markdownRehydrateInterval: ReturnType<typeof setInterval> | undefined;
const processingUploadChannels = new Set<string>();

type MessageLocation = {
  index: number;
  message: Record<string, any>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMessageLocation(args: any[]): MessageLocation {
  const first = args[0];
  const second = args[1];

  if (second && typeof second === "object") return { index: 1, message: second };
  if (first && typeof first === "object") return { index: 0, message: first };
  return { index: 1, message: {} };
}

function extractContent(value: any, depth = 0): string {
  if (value == null || depth > 4) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";

  for (const key of ["content", "text", "value", "rawContent", "messageContent", "pendingContent"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }

  for (const key of ["message", "draft", "state", "editor", "input", "composerState", "formState", "richValue"]) {
    const candidate = extractContent(value[key], depth + 1);
    if (candidate) return candidate;
  }

  return "";
}

function resolveChannelId(SelectedChannelStore: any, ...values: any[]): string | undefined {
  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string") return value;
    if (typeof value !== "object") continue;

    const direct = value.channelId ?? value.id;
    if (typeof direct === "string" && direct.length > 0) return direct;

    const nested = value.channel?.id;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }

  return SelectedChannelStore?.getChannelId?.();
}

function buildChunkArgs(
  templateArgs: any[],
  channelId: string,
  content: string,
  includeOriginalMessageFields: boolean,
): any[] {
  const nextArgs = [...templateArgs];
  const { index, message } = getMessageLocation(nextArgs);
  const chunkMessage = includeOriginalMessageFields
    ? { ...message, content }
    : {
        content,
        tts: false,
        invalidEmojis: message.invalidEmojis ?? [],
        validNonShortcutEmojis: message.validNonShortcutEmojis ?? [],
      };

  if (typeof nextArgs[0] === "string") {
    nextArgs[0] = channelId;
    nextArgs[1] = chunkMessage;
    return nextArgs;
  }

  if (index === 0) {
    nextArgs[0] = { ...chunkMessage, channelId: message.channelId ?? channelId };
    return nextArgs;
  }

  nextArgs[1] = chunkMessage;
  return nextArgs;
}

function isAutoTextFile(file: any): boolean {
  if (!file) return false;
  const name = String(file.name ?? "");
  const type = String(file.type ?? "");
  return name === "message.txt" && (!type || type === "text/plain");
}

function isAutoTextUpload(upload: any): boolean {
  if (upload?.showLargeMessageDialog) return true;
  return isAutoTextFile(upload?.item?.file);
}

function getChannelUploads(channelId: string, UploadAttachmentStore: any): any[] {
  if (!UploadAttachmentStore?.getUploads) return [];

  try {
    const typed = UploadAttachmentStore.getUploads(channelId, 0);
    if (Array.isArray(typed)) return typed;
  } catch {}

  try {
    const basic = UploadAttachmentStore.getUploads(channelId);
    if (Array.isArray(basic)) return basic;
  } catch {}

  return [];
}

function clearDraftAndUploads(channelId: string, DraftManager: any, UploadManager: any) {
  for (const args of [
    [channelId, 0],
    [channelId],
  ]) {
    try {
      DraftManager?.clearDraft?.(...args);
    } catch {}
    try {
      UploadManager?.clearAll?.(...args);
    } catch {}
  }
}

function showSplitFailure() {
  try {
    showToast("Failed to split Markdown message", getAssetIDByName("Small"));
  } catch {}
}

export default {
  ...basePlugin,
  onLoad() {
    basePlugin.onLoad?.();

    unpatchMarkdownSend?.();
    unpatchMarkdownUpload?.();
    if (markdownRehydrateInterval) clearInterval(markdownRehydrateInterval);
    processingUploadChannels.clear();

    const ChannelStore = findByStoreName("ChannelStore");
    const SelectedChannelStore = findByStoreName("SelectedChannelStore");
    const UserStore = findByStoreName("UserStore");
    const MessageActions = findByProps("sendMessage", "editMessage");
    const UploadHandler = findByProps("promptToUpload");
    const DraftManager = findByProps("clearDraft", "saveDraft");
    const UploadManager = findByProps("clearAll");
    const UploadAttachmentStore = findByProps("getUploads");

    if (!MessageActions || typeof MessageActions.sendMessage !== "function") return;

    const getMaxLength = () => (UserStore?.getCurrentUser?.()?.premiumType === 2 ? 4000 : 2000);
    const getDelay = (channelId: string) => {
      const channel = ChannelStore?.getChannel?.(channelId);
      return Math.max((channel?.rateLimitPerUser ?? 0) * 1000, 1000);
    };

    const sendUploadChunks = async (channelId: string, chunks: string[]) => {
      for (let i = 0; i < chunks.length; i++) {
        await MessageActions.sendMessage(channelId, {
          content: chunks[i],
          tts: false,
          invalidEmojis: [],
          validNonShortcutEmojis: [],
        });
        if (i < chunks.length - 1) await sleep(getDelay(channelId));
      }
    };

    const processAutoTextFile = async (channelId: string, file: any): Promise<boolean> => {
      if (!isAutoTextFile(file) || typeof file.text !== "function") return false;
      if (processingUploadChannels.has(channelId)) return true;

      processingUploadChannels.add(channelId);
      try {
        const text = await file.text();
        if (!text || text.length <= getMaxLength()) return false;

        const chunks = splitMarkdownMessage(text, getMaxLength(), Boolean(storage.splitOnWords));
        if (chunks === false || chunks.length === 0) {
          showSplitFailure();
          return true;
        }

        clearDraftAndUploads(channelId, DraftManager, UploadManager);
        await sendUploadChunks(channelId, chunks);
        return true;
      } finally {
        processingUploadChannels.delete(channelId);
      }
    };

    const pollAutoTextUpload = () => {
      const channelId = SelectedChannelStore?.getChannelId?.();
      if (!channelId || processingUploadChannels.has(channelId)) return;

      const uploads = getChannelUploads(channelId, UploadAttachmentStore);
      if (!uploads.length || !uploads.every(isAutoTextUpload)) return;

      const file = uploads[0]?.item?.file;
      void processAutoTextFile(channelId, file).catch(() => {});
    };

    unpatchMarkdownSend = instead("sendMessage", MessageActions, (args: any[], orig: (...callArgs: any[]) => any) => {
      const sendArgs = args as any[];
      const { message } = getMessageLocation(sendArgs);
      const content = extractContent(message);
      const channelId = resolveChannelId(SelectedChannelStore, sendArgs[0], sendArgs[1], message);

      if (!channelId || !content || content.length <= getMaxLength()) {
        return orig(...sendArgs);
      }

      const chunks = splitMarkdownMessage(content, getMaxLength(), Boolean(storage.splitOnWords));
      if (chunks === false || chunks.length === 0) {
        showSplitFailure();
        return undefined;
      }

      void (async () => {
        for (let i = 0; i < chunks.length; i++) {
          const chunkArgs = buildChunkArgs(sendArgs, channelId, chunks[i], i === 0);
          await orig(...chunkArgs);
          if (i < chunks.length - 1) await sleep(getDelay(channelId));
        }
      })().catch(showSplitFailure);

      return undefined;
    });

    if (UploadHandler && typeof UploadHandler.promptToUpload === "function") {
      unpatchMarkdownUpload = instead("promptToUpload", UploadHandler, (args: any[], orig: (...callArgs: any[]) => any) => {
        const [files, channel, draftType] = args as [any[], any, number | undefined];
        const file = files?.[0];
        const channelId = resolveChannelId(SelectedChannelStore, channel);
        const isChannelDraft = draftType === 0 || draftType == null;

        if (!channelId || !isChannelDraft || !isAutoTextFile(file)) return orig(...args);

        void processAutoTextFile(channelId, file)
          .then((handled) => {
            if (!handled) return orig(...args);
          })
          .catch(() => orig(...args));

        return undefined;
      });
    }

    pollAutoTextUpload();
    markdownRehydrateInterval = setInterval(pollAutoTextUpload, 250);
  },
  onUnload() {
    if (markdownRehydrateInterval) {
      clearInterval(markdownRehydrateInterval);
      markdownRehydrateInterval = undefined;
    }
    processingUploadChannels.clear();
    unpatchMarkdownUpload?.();
    unpatchMarkdownUpload = undefined;
    unpatchMarkdownSend?.();
    unpatchMarkdownSend = undefined;
    basePlugin.onUnload?.();
  },
};
