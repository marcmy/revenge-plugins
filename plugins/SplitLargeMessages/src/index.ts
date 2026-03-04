import { findAll, findByProps, findByStoreName } from "@vendetta/metro";
import { i18n } from "@vendetta/metro/common";
import { before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import settings from "./settings";

let unpatch: (() => void) | undefined;
let unpatchRawSend: (() => void) | undefined;
const patchedLengthModules = new Map<Record<string, any>, Record<string, number>>();
const warningUnpatches: Array<() => void> = [];
const patchedWarningTargets = new Set<object>();
const patchedPopupTargets = new Set<object>();
const patchedUploadTargets = new Set<object>();
const patchedComposerTargets = new Set<object>();
const patchedLargeDialogTargets = new Set<object>();
const patchedSendTargets = new Set<object>();
const rehydratingDraftChannels = new Set<string>();
const sendUnpatches: Array<() => void> = [];
const debugHitKeys = new Set<string>();
let warningPatchInterval: ReturnType<typeof setInterval> | undefined;
let draftRehydrateInterval: ReturnType<typeof setInterval> | undefined;
storage.splitOnWords ??= false;

function logDebug(...args: any[]) {
  try {
    console.log("[SplitLargeMessages]", ...args);
  } catch {}
}

function debugHit(label: string) {
  if (debugHitKeys.has(label)) return;
  debugHitKeys.add(label);
  logDebug("Hit", label);
  try {
    showToast(`SplitLargeMessages: ${label}`, getAssetIDByName("Small"));
  } catch {}
}

function collectTargetsWithMethods(methods: string[]): Array<Record<string, any>> {
  const targets = new Set<Record<string, any>>();
  const hasAnyMethod = (obj: any) => {
    if (!obj || typeof obj !== "object") return false;
    try {
      if (methods.some((method) => typeof obj[method] === "function")) {
        return true;
      }
    } catch {}
    try {
      const proto = Object.getPrototypeOf(obj) as Record<string, any> | null;
      if (!proto || proto === Object.prototype) return false;
      return methods.some((method) => typeof proto[method] === "function");
    } catch {}
    return false;
  };
  const addTarget = (obj: any) => {
    try {
      if (!obj || typeof obj !== "object") return;
      if (hasAnyMethod(obj)) {
        targets.add(obj as Record<string, any>);
      }
    } catch {}
  };

  const modules = findAll((m) => {
    try {
      if (!m || typeof m !== "object") return false;
      if (hasAnyMethod(m)) {
        return true;
      }

      for (const value of Object.values(m as Record<string, any>)) {
        if (!value || typeof value !== "object") continue;
        if (hasAnyMethod(value)) {
          return true;
        }
      }
    } catch {}

    return false;
  }) as Array<Record<string, any>>;

  for (const mod of modules) {
    addTarget(mod);
    try {
      for (const value of Object.values(mod)) {
        addTarget(value);
      }
    } catch {}
  }

  return [...targets];
}

function patchMessageLengthConstants() {
  const patchTarget = (target: any) => {
    if (!target || typeof target !== "object") return;
    const mod = target as Record<string, any>;
    const previousValues = patchedLengthModules.get(mod) ?? {};
    let touched = false;

    for (const key of Object.keys(mod)) {
      if (!key.includes("MAX_MESSAGE_LENGTH")) continue;
      if (typeof mod[key] !== "number") continue;

      if (!(key in previousValues)) {
        previousValues[key] = mod[key];
      }
      mod[key] = 2 ** 30;
      touched = true;
    }

    if (touched) patchedLengthModules.set(mod, previousValues);
  };
  const modules = findAll(
    (m) => m && typeof m === "object" && Object.keys(m).some((key) => key.includes("MAX_MESSAGE_LENGTH")),
  ) as Array<Record<string, any>>;

  for (const mod of modules) {
    patchTarget(mod);
    for (const value of Object.values(mod)) {
      if (!value || typeof value !== "object") continue;
      patchTarget(value);
    }
  }
}

function restoreMessageLengthConstants() {
  for (const [mod, values] of patchedLengthModules) {
    for (const [key, value] of Object.entries(values)) {
      mod[key] = value;
    }
  }

  patchedLengthModules.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function collectStringsDeep(value: any, out: string[] = [], depth = 0): string[] {
  if (value == null || depth > 6) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (typeof value === "function") {
    try {
      out.push(Function.prototype.toString.call(value));
    } catch {}
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStringsDeep(item, out, depth + 1);
    return out;
  }

  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "onConfirm" || k === "onCancel" || k === "render" || k === "children") continue;
      collectStringsDeep(v, out, depth + 1);
    }
  }

  return out;
}

function getLongestStringDeep(value: any, depth = 0, seen = new Set<any>()): string {
  if (value == null || depth > 6) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);

  if (Array.isArray(value)) {
    let best = "";
    for (const item of value) {
      const candidate = getLongestStringDeep(item, depth + 1, seen);
      if (candidate.length > best.length) best = candidate;
    }
    return best;
  }

  let best = "";
  for (const [key, nested] of Object.entries(value)) {
    if (key === "onConfirm" || key === "onCancel" || key === "render" || key === "children") continue;
    const candidate = getLongestStringDeep(nested, depth + 1, seen);
    if (candidate.length > best.length) best = candidate;
  }
  return best;
}

function extractContentFromUnknown(value: any, depth = 0): string {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";

  const directKeys = ["content", "text", "value", "rawContent", "messageContent", "pendingContent"] as const;

  for (const key of directKeys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }

  const nestedKeys = [
    "message",
    "draft",
    "state",
    "editor",
    "input",
    "composerState",
    "formState",
    "richValue",
  ] as const;

  for (const key of nestedKeys) {
    const extracted = extractContentFromUnknown(value[key], depth + 1);
    if (extracted) return extracted;
  }

  return "";
}

function getDraftText(channelId: string, DraftStore: any): string {
  if (!DraftStore?.getDraft) return "";

  try {
    const byType = DraftStore.getDraft(channelId, 0);
    if (typeof byType === "string") return byType;
  } catch {}

  try {
    const basic = DraftStore.getDraft(channelId);
    if (typeof basic === "string") return basic;
  } catch {}

  return "";
}

function isAutoTextFile(file: any): boolean {
  if (!file) return false;
  const name = String(file.name ?? "");
  const type = String(file.type ?? "");
  if (name !== "message.txt") return false;
  return !type || type === "text/plain";
}

function isAutoTextUpload(upload: any): boolean {
  if (upload?.showLargeMessageDialog) return true;
  const file = upload?.item?.file;
  const name = String(upload?.filename ?? file?.name ?? "");
  const type = String(upload?.mimeType ?? file?.type ?? "");
  if (name !== "message.txt") return false;
  return !type || type === "text/plain";
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
      }, ""),
    );
  }

  if (chunks.length && !chunks.some((chunk) => chunk.length > maxChunkLength)) {
    return chunks.map((c) => c.trim());
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
    }, ""),
  );

  if (chunks.some((chunk) => chunk.length > maxChunkLength)) return false;
  return chunks.map((c) => c.trim());
}

export default {
  onLoad() {
    const ChannelStore = findByStoreName("ChannelStore");
    const SelectedChannelStore = findByStoreName("SelectedChannelStore");
    const UserStore = findByStoreName("UserStore");
    const MessageActions = findByProps("sendMessage", "editMessage");
    const DraftStore = findByProps("getDraft");
    const DraftManager = findByProps("clearDraft", "saveDraft");
    const UploadManager = findByProps("clearAll");
    const UploadAttachmentStore = findByProps("getUploads");
    const UploadHandler = findByProps("promptToUpload");
    const Popup = findByProps("show", "openLazy");
    const ModalManager = findByProps("openModal", "openModalLazy");

    const originalSendMessage = MessageActions.sendMessage.bind(MessageActions);
    const sendChunk = async (channelId: string, message: { [key: string]: any }, content: string) => {
      const chunkMessage = {
        invalidEmojis: message.invalidEmojis,
        validNonShortcutEmojis: message.validNonShortcutEmojis,
        tts: false,
        content,
      };

      await originalSendMessage(channelId, chunkMessage);
    };

    const getMaxLength = () => (UserStore.getCurrentUser()?.premiumType === 2 ? 4000 : 2000);
    const sendChunksSequentially = async (channelId: string, chunks: string[]) => {
      for (const content of chunks) {
        await sendChunk(channelId, {}, content);
      }
    };
    const getChannelUploads = (channelId: string) => {
      if (!UploadAttachmentStore?.getUploads) return [] as any[];

      try {
        const byType = UploadAttachmentStore.getUploads(channelId, 0);
        if (Array.isArray(byType)) return byType;
      } catch {}

      try {
        const basic = UploadAttachmentStore.getUploads(channelId);
        if (Array.isArray(basic)) return basic;
      } catch {}

      return [] as any[];
    };
    const clearDraftAndUploads = (channelId: string) => {
      try {
        DraftManager?.clearDraft?.(channelId, 0);
      } catch {}
      try {
        DraftManager?.clearDraft?.(channelId);
      } catch {}
      try {
        UploadManager?.clearAll?.(channelId, 0);
      } catch {}
      try {
        UploadManager?.clearAll?.(channelId);
      } catch {}
    };
    const trySaveDraftText = (channelId: string, text: string) => {
      if (!DraftManager?.saveDraft) return false;

      const before = getDraftText(channelId, DraftStore);
      const attempts = [
        () => DraftManager.saveDraft(channelId, 0, text),
        () => DraftManager.saveDraft(channelId, text, 0),
        () => DraftManager.saveDraft(channelId, text),
      ];

      for (const attempt of attempts) {
        try {
          attempt();
          const after = getDraftText(channelId, DraftStore);
          if (after === text || after.length > before.length) return true;
        } catch {}
      }

      return false;
    };
    const rehydrateDraftFromAutoTextUpload = (channelId: string) => {
      if (rehydratingDraftChannels.has(channelId)) return;

      const uploads = getChannelUploads(channelId);
      if (!uploads.length || !uploads.every(isAutoTextUpload)) return;

      const file = uploads[0]?.item?.file;
      if (!file?.text) return;

      rehydratingDraftChannels.add(channelId);
      void file
        .text()
        .then((text: string) => {
          if (!text || text.length <= getMaxLength()) return;

          const draft = getDraftText(channelId, DraftStore);
          if (draft === text) {
            try {
              UploadManager?.clearAll?.(channelId, 0);
            } catch {}
            try {
              UploadManager?.clearAll?.(channelId);
            } catch {}
            return;
          }

          if (trySaveDraftText(channelId, text)) {
            try {
              UploadManager?.clearAll?.(channelId, 0);
            } catch {}
            try {
              UploadManager?.clearAll?.(channelId);
            } catch {}
          }
        })
        .catch(() => {})
        .finally(() => {
          rehydratingDraftChannels.delete(channelId);
        });
    };
    const pollDraftRehydrate = () => {
      const channelId = SelectedChannelStore?.getChannelId?.();
      if (!channelId) return;
      rehydrateDraftFromAutoTextUpload(channelId);
    };
    const splitAndSend = (channelId: string, rawContent?: string) => {
      const content = (typeof rawContent === "string" ? rawContent : "") || getDraftText(channelId, DraftStore);
      if (!content || content.length <= getMaxLength()) return false;

      const chunks = intoChunks(content, getMaxLength());
      if (!chunks?.length) return false;

      const nonEmptyChunks = chunks.filter((c) => c.length > 0);
      if (!nonEmptyChunks.length) return false;

      logDebug("Splitting oversized message", { channelId, length: content.length, chunks: nonEmptyChunks.length });
      void sendChunksSequentially(channelId, nonEmptyChunks);
      clearDraftAndUploads(channelId);
      return true;
    };
    const splitAndSendFromChannel = (channelId: string, rawContent?: string) => {
      if (splitAndSend(channelId, rawContent)) return true;
      const uploads = getChannelUploads(channelId);
      for (const upload of uploads) {
        const uploadFile = upload?.item?.file;
        if (splitAndSendFromAutoTextFile(channelId, uploadFile)) return true;
      }
      rehydrateDraftFromAutoTextUpload(channelId);
      if (splitAndSend(channelId)) return true;
      return false;
    };
    const splitAndSendFromAutoTextFile = (channelId: string, file: any) => {
      if (!file?.text || !isAutoTextFile(file)) return false;

      void file
        .text()
        .then((text: string) => {
          if (!text || text.length <= getMaxLength()) return;
          splitAndSendFromChannel(channelId, text);
        })
        .catch(() => {});

      return true;
    };
    const handleTooLongWarning = (props: any, orig: (props: any) => any) => {
      const channelId = props?.channel?.id ?? props?.channelId ?? SelectedChannelStore?.getChannelId?.();
      if (!channelId) return orig(props);

      const content = extractContentFromUnknown(props) || getDraftText(channelId, DraftStore);

      debugHit("warning");
      if (!splitAndSendFromChannel(channelId, content)) return orig(props);

      return { shouldClear: false, shouldRefocus: true };
    };
    const handleTooLongPopup = (modalArgs: any[], orig: (...args: any[]) => any) => {
      const modalText = collectStringsDeep(modalArgs).join(" ").replace(/\s+/g, " ").toLowerCase();

      const i18nTooLong = String(i18n?.Messages?.YOUR_MESSAGE_IS_TOO_LONG ?? "").toLowerCase();
      const looksLikeTooLongModal =
        modalText.includes("your message is too long") ||
        modalText.includes("up to 4000 characters") ||
        modalText.includes("2000 character count limit") ||
        modalText.includes("your_message_is_too_long") ||
        modalText.includes("showlargemessagedialog") ||
        (i18nTooLong && modalText.includes(i18nTooLong));

      if (!looksLikeTooLongModal) return orig(...modalArgs);

      const channelId = SelectedChannelStore?.getChannelId?.();
      if (!channelId) return orig(...modalArgs);

      const modalContent = getLongestStringDeep(modalArgs);
      debugHit("popup");
      if (!splitAndSendFromChannel(channelId, modalContent)) return orig(...modalArgs);

      return undefined;
    };

    const patchWarningTargets = () => {
      const warningTargets = collectTargetsWithMethods(["openWarningPopout"]);
      let patchedCount = 0;

      for (const target of warningTargets) {
        if (patchedWarningTargets.has(target)) continue;
        patchedWarningTargets.add(target);
        try {
          warningUnpatches.push(
            instead("openWarningPopout", target, ([props], orig) =>
              handleTooLongWarning(props, orig as (props: any) => any),
            ),
          );
        } catch {}
        patchedCount++;
      }

      if (patchedCount > 0) logDebug("Patched warning targets", patchedCount);
    };
    const patchPopupTargets = () => {
      const targets = collectTargetsWithMethods(["show", "openLazy", "openModal", "openModalLazy"]);
      if (Popup && typeof Popup === "object") targets.push(Popup as Record<string, any>);
      if (ModalManager && typeof ModalManager === "object") targets.push(ModalManager as Record<string, any>);
      let patchedCount = 0;

      for (const target of targets) {
        if (patchedPopupTargets.has(target)) continue;
        patchedPopupTargets.add(target);

        for (const method of ["show", "openLazy", "openModal", "openModalLazy"] as const) {
          try {
            if (typeof target[method] !== "function") continue;
            warningUnpatches.push(
              instead(method, target, (args, orig) =>
                handleTooLongPopup(args as any[], orig as (...args: any[]) => any),
              ),
            );
          } catch {}
        }
        patchedCount++;
      }

      if (patchedCount > 0) logDebug("Patched popup targets", patchedCount);
    };
    const patchUploadTargets = () => {
      const targets = collectTargetsWithMethods(["promptToUpload"]);

      if (UploadHandler && typeof UploadHandler === "object" && typeof UploadHandler.promptToUpload === "function") {
        targets.push(UploadHandler as Record<string, any>);
      }
      let patchedCount = 0;

      for (const target of targets) {
        if (patchedUploadTargets.has(target)) continue;
        patchedUploadTargets.add(target);

        try {
          warningUnpatches.push(
            instead("promptToUpload", target, ([files, channel, draftType], orig) => {
              const file = files?.[0];
              const channelId = channel?.id ?? SelectedChannelStore?.getChannelId?.();
              const looksLikeAutoText = isAutoTextFile(file);
              const isChannelDraft = draftType === 0 || draftType == null;

              if (!channelId || !looksLikeAutoText || !isChannelDraft) {
                return orig(files, channel, draftType);
              }

              if (splitAndSendFromAutoTextFile(channelId, file)) {
                return undefined;
              }

              if (file?.text) {
                void file
                  .text()
                  .then((text: string) => {
                    if (text && text.length > getMaxLength()) {
                      splitAndSendFromChannel(channelId, text);
                      return;
                    }

                    orig(files, channel, draftType);
                  })
                  .catch(() => {
                    if (!splitAndSendFromChannel(channelId)) {
                      orig(files, channel, draftType);
                    }
                  });
                return undefined;
              }

              if (!splitAndSendFromChannel(channelId)) return orig(files, channel, draftType);

              return undefined;
            }),
          );
        } catch {}
        patchedCount++;
      }

      if (patchedCount > 0) logDebug("Patched upload targets", patchedCount);
    };
    const patchComposerTargets = () => {
      const targets = collectTargetsWithMethods(["handleSendMessage"]);
      let patchedCount = 0;

      for (const target of targets) {
        if (patchedComposerTargets.has(target)) continue;
        patchedComposerTargets.add(target);

        try {
          warningUnpatches.push(
            instead("handleSendMessage", target, (args, orig) => {
              const [firstArg] = args as [Record<string, any> | undefined];
              const channelId =
                firstArg?.channel?.id ?? firstArg?.channelId ?? firstArg?.id ?? SelectedChannelStore?.getChannelId?.();

              if (!channelId) return orig(...args);

              const directContent = extractContentFromUnknown(firstArg);

              debugHit("composer");
              if (!splitAndSendFromChannel(channelId, directContent)) return orig(...args);
              return undefined;
            }),
          );
        } catch {}
        patchedCount++;
      }

      if (patchedCount > 0) logDebug("Patched composer targets", patchedCount);
    };
    const patchLargeDialogTargets = () => {
      const methods = ["showLargeMessageDialog", "showMessageTooLongDialog", "openLargeMessageDialog"] as const;
      const targets = collectTargetsWithMethods([...methods]);
      let patchedCount = 0;

      for (const target of targets) {
        if (patchedLargeDialogTargets.has(target)) continue;
        patchedLargeDialogTargets.add(target);

        for (const method of methods) {
          try {
            if (typeof target[method] !== "function") continue;
            warningUnpatches.push(
              instead(method, target, (args, orig) => {
                const [firstArg] = args as [Record<string, any> | undefined];
                const channelId =
                  firstArg?.channel?.id ??
                  firstArg?.channelId ??
                  firstArg?.id ??
                  SelectedChannelStore?.getChannelId?.();
                if (!channelId) return orig(...args);

                const directContent = extractContentFromUnknown(firstArg);

                debugHit("large-dialog");
                if (!splitAndSendFromChannel(channelId, directContent)) return orig(...args);
                return undefined;
              }),
            );
          } catch {}
        }
        patchedCount++;
      }

      if (patchedCount > 0) logDebug("Patched large-dialog targets", patchedCount);
    };
    const patchAllSendTargets = () => {
      const targets = collectTargetsWithMethods(["sendMessage", "_sendMessage"]);
      let patchedCount = 0;

      for (const target of targets) {
        if (patchedSendTargets.has(target)) continue;
        patchedSendTargets.add(target);
        patchedCount++;

        if (typeof target.sendMessage === "function") {
          try {
            sendUnpatches.push(
              instead("sendMessage", target, (args, orig) => {
                const [channelId, message] = args as [string, { content?: string; [key: string]: any }];
                const content = extractContentFromUnknown(message) || getLongestStringDeep(message);
                if (content && content.length > getMaxLength()) {
                  debugHit("send-target");
                  if (splitAndSendFromChannel(channelId, content)) return undefined;
                }
                return (orig as (...rest: any[]) => any)(...args);
              }),
            );
          } catch {}
        }

        if (typeof target._sendMessage === "function") {
          try {
            sendUnpatches.push(
              before("_sendMessage", target, (args) => {
                const [channelId, message] = args as [string, { content?: string; [key: string]: any }];
                const content = extractContentFromUnknown(message) || getLongestStringDeep(message);
                if (!content || content.length <= getMaxLength()) return;

                debugHit("raw-send-target");
                const chunks = intoChunks(content, getMaxLength());
                if (!chunks) {
                  message.content = "";
                  showToast("Failed to split message", getAssetIDByName("Small"));
                  return;
                }

                const nonEmptyChunks = chunks.filter((chunk) => chunk.length > 0);
                if (!nonEmptyChunks.length) {
                  message.content = "";
                  showToast("Failed to split message", getAssetIDByName("Small"));
                  return;
                }

                message.content = nonEmptyChunks.shift() ?? "";
                void sendChunksSequentially(channelId, nonEmptyChunks);
              }),
            );
          } catch {}
        }
      }

      if (patchedCount > 0) logDebug("Patched send targets", patchedCount);
    };

    logDebug("Plugin loaded");
    patchMessageLengthConstants();
    patchWarningTargets();
    patchPopupTargets();
    patchUploadTargets();
    patchComposerTargets();
    patchLargeDialogTargets();
    patchAllSendTargets();
    pollDraftRehydrate();
    draftRehydrateInterval = setInterval(pollDraftRehydrate, 250);
    warningPatchInterval = setInterval(() => {
      patchMessageLengthConstants();
      patchWarningTargets();
      patchPopupTargets();
      patchUploadTargets();
      patchComposerTargets();
      patchLargeDialogTargets();
      patchAllSendTargets();
    }, 3000);

    unpatch?.();
    unpatchRawSend?.();
    debugHit("loaded");
    unpatch = instead("sendMessage", MessageActions, (args, orig) => {
      const [channelId, message] = args as [string, { content?: string; [key: string]: any }];
      const content = extractContentFromUnknown(message) || getLongestStringDeep(message);

      if (splitAndSendFromChannel(channelId, content)) {
        debugHit("sendMessage");
        return undefined;
      }

      if (!content || content.length <= getMaxLength()) {
        return (orig as (channelId: string, message: Record<string, any>) => any)(channelId, message);
      }

      const chunks = intoChunks(content, getMaxLength());
      if (!chunks) {
        showToast("Failed to split message", getAssetIDByName("Small"));
        return undefined;
      }

      const nonEmptyChunks = chunks.filter((chunk) => chunk.length > 0);
      if (!nonEmptyChunks.length) {
        showToast("Failed to split message", getAssetIDByName("Small"));
        return undefined;
      }

      const firstChunk = nonEmptyChunks.shift() ?? "";
      const firstMessage = {
        ...message,
        content: firstChunk,
      };

      const channel = ChannelStore.getChannel(channelId);
      void (async () => {
        await originalSendMessage(channelId, firstMessage);
        for (const chunk of nonEmptyChunks) {
          await sleep(Math.max((channel?.rateLimitPerUser ?? 0) * 1000, 1000));
          await sendChunk(channelId, message, chunk);
        }
      })();

      return undefined;
    });
    if (typeof MessageActions._sendMessage === "function") {
      unpatchRawSend = before("_sendMessage", MessageActions, (args) => {
        const [channelId, message] = args as [string, { content?: string; [key: string]: any }];
        const content = extractContentFromUnknown(message) || getLongestStringDeep(message);

        if (!content || content.length <= getMaxLength()) return;
        debugHit("_sendMessage");

        const chunks = intoChunks(content, getMaxLength());
        if (!chunks) {
          message.content = "";
          showToast("Failed to split message", getAssetIDByName("Small"));
          return;
        }

        const nonEmptyChunks = chunks.filter((chunk) => chunk.length > 0);
        if (!nonEmptyChunks.length) {
          message.content = "";
          showToast("Failed to split message", getAssetIDByName("Small"));
          return;
        }

        message.content = nonEmptyChunks.shift() ?? "";
        void sendChunksSequentially(channelId, nonEmptyChunks);
      });
    }
  },
  onUnload: () => {
    unpatch?.();
    unpatch = undefined;
    unpatchRawSend?.();
    unpatchRawSend = undefined;
    if (warningPatchInterval) {
      clearInterval(warningPatchInterval);
      warningPatchInterval = undefined;
    }
    if (draftRehydrateInterval) {
      clearInterval(draftRehydrateInterval);
      draftRehydrateInterval = undefined;
    }
    while (warningUnpatches.length) {
      try {
        warningUnpatches.pop()?.();
      } catch {}
    }
    while (sendUnpatches.length) {
      try {
        sendUnpatches.pop()?.();
      } catch {}
    }
    patchedWarningTargets.clear();
    patchedPopupTargets.clear();
    patchedUploadTargets.clear();
    patchedComposerTargets.clear();
    patchedLargeDialogTargets.clear();
    patchedSendTargets.clear();
    debugHitKeys.clear();
    rehydratingDraftChannels.clear();

    restoreMessageLengthConstants();
  },
  settings,
};
