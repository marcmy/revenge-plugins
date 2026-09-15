import {
  CAPTURE_SUBSCRIPTION_TYPES,
  MESSAGE_CACHE_LIMIT,
  RecentMessageCache,
  contentChanged,
  getDeleteEventTargets,
  mergeMessageUpdate,
  snapshotMessage,
} from "../.codex-tmp/MessageHistory/capture.mjs";

const requiredCaptureTypes = [
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "MESSAGE_DELETE_BULK",
  "LOAD_MESSAGES_SUCCESS",
  "LOCAL_MESSAGES_LOADED",
];
for (const type of requiredCaptureTypes) {
  if (!CAPTURE_SUBSCRIPTION_TYPES.includes(type)) {
    throw new Error(`Expected capture subscription fallback to include ${type}`);
  }
}

const singleDeleteTargets = getDeleteEventTargets({
  type: "MESSAGE_DELETE",
  channelId: "10",
  id: "100",
});
if (
  singleDeleteTargets.length !== 1 ||
  singleDeleteTargets[0].channelId !== "10" ||
  singleDeleteTargets[0].messageId !== "100"
) {
  throw new Error("Expected single MESSAGE_DELETE target extraction");
}

const bulkDeleteTargets = getDeleteEventTargets({
  type: "MESSAGE_DELETE_BULK",
  channelId: "10",
  ids: ["100", "101", "102"],
});
if (
  bulkDeleteTargets.length !== 3 ||
  bulkDeleteTargets.some((target, index) => target.channelId !== "10" || target.messageId !== String(100 + index))
) {
  throw new Error("Expected MESSAGE_DELETE_BULK target extraction");
}

const original = {
  id: "100",
  channel_id: "10",
  content: "hello",
  attachments: [{ id: "a" }],
  embeds: [{ type: "rich" }],
  author: { id: "1", username: "marc" },
  timestamp: "2026-09-14T20:00:00.000Z",
};

const metadataOnly = mergeMessageUpdate(original, {
  id: "100",
  channel_id: "10",
  embeds: [{ type: "rich", title: "hydrated" }],
});
if (metadataOnly.content !== "hello" || metadataOnly.attachments.length !== 1 || metadataOnly.timestamp !== original.timestamp) {
  throw new Error("Expected partial updates to preserve omitted message fields");
}
if (contentChanged(snapshotMessage(original), snapshotMessage(metadataOnly))) {
  throw new Error("Expected metadata-only update not to count as an edit");
}

const edited = mergeMessageUpdate(original, {
  id: "100",
  channel_id: "10",
  content: "hello edited",
  edited_timestamp: "2026-09-14T20:01:00.000Z",
});
if (!contentChanged(snapshotMessage(original), snapshotMessage(edited))) {
  throw new Error("Expected a real content edit to be detected");
}

const emptyEdit = mergeMessageUpdate(original, {
  id: "100",
  channel_id: "10",
  content: "",
  edited_timestamp: "2026-09-14T20:02:00.000Z",
});
if (emptyEdit.content !== "" || !contentChanged(snapshotMessage(original), snapshotMessage(emptyEdit))) {
  throw new Error("Expected an explicit empty-content edit to be preserved and detected");
}

const cache = new RecentMessageCache(MESSAGE_CACHE_LIMIT);
for (let i = 0; i < MESSAGE_CACHE_LIMIT + 20; i++) {
  cache.set({ ...original, id: String(1000 + i) });
}
if (cache.size !== MESSAGE_CACHE_LIMIT) {
  throw new Error(`Expected bounded cache size ${MESSAGE_CACHE_LIMIT}, got ${cache.size}`);
}
if (cache.get("10", "1000")) {
  throw new Error("Expected oldest cache entry to be evicted");
}

const newestId = String(1000 + MESSAGE_CACHE_LIMIT + 19);
if (!cache.get("10", newestId)) {
  throw new Error("Expected newest cache entry to remain available");
}

const lru = new RecentMessageCache(3);
lru.set({ ...original, id: "1" });
lru.set({ ...original, id: "2" });
lru.set({ ...original, id: "3" });
if (!lru.get("10", "1")) {
  throw new Error("Expected LRU probe entry to exist before eviction");
}
lru.set({ ...original, id: "4" });
if (lru.get("10", "2")) {
  throw new Error("Expected least-recently-used entry to be evicted after a cache hit refreshes recency");
}
if (!lru.get("10", "1") || !lru.get("10", "3") || !lru.get("10", "4")) {
  throw new Error("Expected recently used cache entries to survive LRU eviction");
}

cache.clear();
if (cache.size !== 0) {
  throw new Error("Expected cache.clear() to remove all entries");
}

console.log("message history capture ok");
