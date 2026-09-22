import { findAll, findByProps, findByStoreName } from "@vendetta/metro";
import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import { splitMarkdownMessage } from "./markdownSplitter";
import settings from "./settings";

const MESSAGE_LIMIT = 2000;
const NITRO_MESSAGE_LIMIT = 4000;
const MIN_SEND_DELAY_MS = 1000;

let unpatchSend: (() => void) | undefined;
let unpatchUpload: (() => void) | undefined;
const retryTimers: Array<ReturnType<typeof setTimeout>> = [];
const patchedLengthModules = new Map<Record<string, any>, Record<string, number>>();
const activeSplitChannels = new Set<string>();

type MessageLocation = {
  index: number;
  message: Record<string, any>;
};

function logDebug(...args: any[]) {
  try {
    console.log("[SplitLargeMessages]", ...args);
  } catch {}
}

function showFailure(message = "Failed to split message") {
  try {
    showToast(message, getAssetIDByName("Small"));
  } catch {}
}

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

    const direct = value.channelId ?? value.channel_id ?? value.id;
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

function patchMessageLengthConstants() {
  const patchTarget = (target: any) => {
    if (!target || typeof target !== "object") return;

    const mod = target as Record<string, any>;
    let previousValues = patchedLengthModules.get(mod);
    if (!previousValues) previousValues = {};

    let touched = false;
    let descriptors: Record<string, PropertyDescriptor>;

    try {
      descriptors = Object.getOwnPropertyDescriptors(mod);
    } catch {
      return;
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!key.includes("MESSAGE_LENGTH")) continue;
      if (!("value" in descriptor) || typeof descriptor.value !== "number") continue;
      if (descriptor.value <= 0 || descriptor.value > 10000) continue;

      try {
        if (!(key in previousValues)) previousValues[key] = descriptor.value;
        mod[key] = 1_000_000;
        touched = true;
      } catch {}
    }

    if (touched) patchedLengthModules.set(mod, previousValues);
  };

  const modules = findAll((module) => {
    try {
      return (
        module &&
        typeof module === "object" &&
        Object.keys(module).some((key) => key.includes("MESSAGE_LENGTH"))
      );
    } catch {
      return false;
    }
  }) as Array<Record<string, any>>;

  for (const module of modules) {
    patchTarget(module);
    try {
      for (const value of Object.values(module)) patchTarget(value);
    } catch {}
  }
}

function restoreMessageLengthConstants() {
  for (const [module, values] of patchedLengthModules) {
    for (const [key, value] of Object.entries(values)) {
      try {
        module[key] = value;
      } catch {}
    }
  }
  patchedLengthModules.clear();
}

export default {
  onLoad() {
    storage.splitOnWords ??= false;

    const ChannelStore = findByStoreName("ChannelStore");
    const SelectedChannelStore = findByStoreName("SelectedChannelStore");
    const UserStore = findByStoreName("UserStore");
    const MessageActions = findByProps("sendMessage", "editMessage");
    const UploadHandler = findByProps("promptToUpload");
    const DraftManager = findByProps("clearDraft", "saveDraft");
    const UploadManager = findByProps("clearAll");

    if (!MessageActions || typeof MessageActions.sendMessage !== "function") {
      showFailure("SplitLargeMessages: send API unavailable");
      return;
    }

    const originalSendMessage = MessageActions.sendMessage.bind(MessageActions);

    const getMaxLength = () =>
      UserStore?.getCurrentUser?.()?.premiumType === 2 ? NITRO_MESSAGE_LIMIT : MESSAGE_LIMIT;

    const getSendDelay = (channelId: string) => {
      const channel = ChannelStore?.getChannel?.(channelId);
      return Math.max((channel?.rateLimitPerUser ?? 0) * 1000, MIN_SEND_DELAY_MS);
    };

    const splitContent = (content: string) =>
      splitMarkdownMessage(content, getMaxLength(), Boolean(storage.splitOnWords));

    const sendStandaloneChunks = async (channelId: string, chunks: string[]) => {
      const delay = getSendDelay(channelId);

      for (let index = 0; index < chunks.length; index++) {
        await originalSendMessage(channelId, {
          content: chunks[index],
          tts: false,
          invalidEmojis: [],
          validNonShortcutEmojis: [],
        });

        if (index < chunks.length - 1) await sleep(delay);
      }
    };

    const processAutoTextFile = async (channelId: string, file: any): Promise<boolean> => {
      if (!isAutoTextFile(file) || typeof file.text !== "function") return false;
      if (activeSplitChannels.has(channelId)) return true;

      let text: string;
      try {
        text = await file.text();
      } catch {
        return false;
      }

      if (!text || text.length <= getMaxLength()) return false;

      const chunks = splitContent(text);
      if (chunks === false || chunks.length === 0) {
        showFailure();
        return true;
      }

      activeSplitChannels.add(channelId);
      clearDraftAndUploads(channelId, DraftManager, UploadManager);

      try {
        logDebug("Sending converted message.txt as chunks", {
          channelId,
          length: text.length,
          chunks: chunks.length,
        });
        await sendStandaloneChunks(channelId, chunks);
      } catch (error) {
        console.error("[SplitLargeMessages] upload split send failed", error);
        showFailure("SplitLargeMessages: sending failed");
      } finally {
        activeSplitChannels.delete(channelId);
      }

      return true;
    };

    patchMessageLengthConstants();
    retryTimers.push(setTimeout(patchMessageLengthConstants, 3000));
    retryTimers.push(setTimeout(patchMessageLengthConstants, 10000));

    unpatchSend?.();
    unpatchUpload?.();

    unpatchSend = instead(
      "sendMessage",
      MessageActions,
      (args: any[], orig: (...callArgs: any[]) => any) => {
        const sendArgs = args as any[];
        const { message } = getMessageLocation(sendArgs);
        const content = extractContent(message);
        const channelId = resolveChannelId(
          SelectedChannelStore,
          sendArgs[0],
          sendArgs[1],
          message,
        );

        if (!channelId || !content || content.length <= getMaxLength()) {
          return orig(...sendArgs);
        }

        if (activeSplitChannels.has(channelId)) {
          logDebug("Suppressed duplicate oversized send while split is active", channelId);
          return undefined;
        }

        const chunks = splitContent(content);
        if (chunks === false || chunks.length === 0) {
          showFailure();
          return undefined;
        }

        activeSplitChannels.add(channelId);
        clearDraftAndUploads(channelId, DraftManager, UploadManager);

        logDebug("Splitting oversized send", {
          channelId,
          length: content.length,
          chunks: chunks.length,
        });

        void (async () => {
          const delay = getSendDelay(channelId);

          try {
            for (let index = 0; index < chunks.length; index++) {
              const chunkArgs = buildChunkArgs(
                sendArgs,
                channelId,
                chunks[index],
                index === 0,
              );

              await orig(...chunkArgs);
              if (index < chunks.length - 1) await sleep(delay);
            }
          } catch (error) {
            console.error("[SplitLargeMessages] split send failed", error);
            showFailure("SplitLargeMessages: sending failed");
          } finally {
            activeSplitChannels.delete(channelId);
          }
        })();

        return undefined;
      },
    );

    if (UploadHandler && typeof UploadHandler.promptToUpload === "function") {
      unpatchUpload = instead(
        "promptToUpload",
        UploadHandler,
        (args: any[], orig: (...callArgs: any[]) => any) => {
          const [files, channel, draftType] = args as [any[], any, number | undefined];
          const file = files?.[0];
          const channelId = resolveChannelId(SelectedChannelStore, channel);
          const isChannelDraft = draftType === 0 || draftType == null;

          if (!channelId || !isChannelDraft || !isAutoTextFile(file)) {
            return orig(...args);
          }

          if (activeSplitChannels.has(channelId)) return undefined;

          void processAutoTextFile(channelId, file)
            .then((handled) => {
              if (!handled) return orig(...args);
            })
            .catch((error) => {
              console.error("[SplitLargeMessages] message.txt interception failed", error);
              return orig(...args);
            });

          return undefined;
        },
      );
    }

    logDebug("Loaded stable send path");
  },

  onUnload() {
    unpatchUpload?.();
    unpatchUpload = undefined;
    unpatchSend?.();
    unpatchSend = undefined;

    while (retryTimers.length) {
      const timer = retryTimers.pop();
      if (timer) clearTimeout(timer);
    }

    activeSplitChannels.clear();
    restoreMessageLengthConstants();
  },

  settings,
};
