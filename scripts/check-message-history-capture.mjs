import {
  MESSAGE_CACHE_LIMIT,
  RecentMessageCache,
  contentChanged,
  mergeMessageUpdate,
  snapshotMessage,
} from "../.codex-tmp/MessageHistory/capture.mjs";

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
if (metadataOnly.content !== "hello" || metadataOnly.attachments.length !== 1) {
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

cache.clear();
if (cache.size !== 0) {
  throw new Error("Expected cache.clear() to remove all entries");
}

console.log("message history capture ok");
