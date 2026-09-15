import { existsSync, readFileSync } from "node:fs";

import {
  createRenderRefreshScheduler,
  getLoadedMessageWindow,
  mergeDeletedRows,
} from "../.codex-tmp/MessageHistory/overlay.mjs";

const real = (id, timestamp) => ({
  rowType: "MESSAGE",
  message: { id, channel_id: "c", timestamp },
});
const loadBefore = { rowType: "load_before" };
const loadAfter = { rowType: "load_after" };
const day = { rowType: "DAY" };

const deleteRecord = (messageId, timestamp, extra = {}) => ({
  id: `delete:c:${messageId}:1`,
  kind: "delete",
  channelId: "c",
  guildId: "g",
  messageId,
  authorId: "u",
  authorUsername: "marc",
  content: `deleted ${messageId}`,
  attachments: [],
  embeds: [],
  timestamp: Date.parse(timestamp) + 5_000,
  messageTimestamp: Date.parse(timestamp),
  inlineHidden: false,
  ...extra,
});

const tombstone = (record) => ({
  rowType: "MESSAGE",
  message: {
    id: record.messageId,
    channel_id: record.channelId,
    timestamp: new Date(record.messageTimestamp).toISOString(),
    message_history_overlay_deleted: true,
  },
});

const extractIds = (rows) => rows.map((row) => row?.message?.id).filter(Boolean);
const assertIds = (rows, expected, label) => {
  const actual = extractIds(rows);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const newestRows = [
  loadBefore,
  real("300", "2026-09-14T20:30:00.000Z"),
  day,
  real("400", "2026-09-14T20:40:00.000Z"),
];
const records = [
  deleteRecord("150", "2026-09-14T20:15:00.000Z"),
  deleteRecord("350", "2026-09-14T20:35:00.000Z"),
  deleteRecord("450", "2026-09-14T20:45:00.000Z"),
];

const newestWindow = getLoadedMessageWindow(newestRows, true, false);
if (!newestWindow || newestWindow.hasMoreBefore !== true || newestWindow.hasMoreAfter !== false) {
  throw new Error("Expected loaded-window metadata to be preserved");
}

const newest = mergeDeletedRows(newestRows, records, tombstone, {
  hasMoreBefore: true,
  hasMoreAfter: false,
});
assertIds(newest, ["300", "350", "400", "450"], "newest window placement");
if (newest[0] !== loadBefore || !newest.includes(day)) {
  throw new Error("Expected non-message native rows to retain their relative presence");
}
if (newestRows.length !== 4) {
  throw new Error("Expected overlay merge not to mutate the input row array");
}

const extendedRows = [
  real("100", "2026-09-14T20:10:00.000Z"),
  real("200", "2026-09-14T20:20:00.000Z"),
  ...newestRows.slice(1),
];
const extended = mergeDeletedRows(extendedRows, records, tombstone, {
  hasMoreBefore: false,
  hasMoreAfter: false,
});
assertIds(extended, ["100", "150", "200", "300", "350", "400", "450"], "extended window placement");

const descendingRows = [
  real("400", "2026-09-14T20:40:00.000Z"),
  real("300", "2026-09-14T20:30:00.000Z"),
];
const descending = mergeDeletedRows(descendingRows, [records[1]], tombstone, {
  hasMoreBefore: true,
  hasMoreAfter: false,
});
assertIds(descending, ["400", "350", "300"], "descending stream placement");

const duplicateRecords = [
  records[1],
  { ...records[1], id: "dup", timestamp: records[1].timestamp + 1 },
];
const deduped = mergeDeletedRows(newestRows, duplicateRecords, tombstone, {
  hasMoreBefore: true,
  hasMoreAfter: false,
});
if (extractIds(deduped).filter((id) => id === "350").length !== 1) {
  throw new Error("Expected one tombstone per channel/message id");
}

const hidden = mergeDeletedRows(
  newestRows,
  [{ ...records[1], inlineHidden: true }],
  tombstone,
  { hasMoreBefore: true, hasMoreAfter: false },
);
assertIds(hidden, ["300", "400"], "hidden record exclusion");

const closedOlderEdge = mergeDeletedRows(
  [real("300", "2026-09-14T20:30:00.000Z"), real("400", "2026-09-14T20:40:00.000Z")],
  [records[0]],
  tombstone,
  { hasMoreBefore: false, hasMoreAfter: true },
);
assertIds(closedOlderEdge, ["150", "300", "400"], "closed older edge");

const openNewerEdge = mergeDeletedRows(
  [real("300", "2026-09-14T20:30:00.000Z"), real("400", "2026-09-14T20:40:00.000Z"), loadAfter],
  [records[2]],
  tombstone,
  { hasMoreBefore: true, hasMoreAfter: true },
);
assertIds(openNewerEdge, ["300", "400"], "open newer edge exclusion");
if (openNewerEdge[openNewerEdge.length - 1] !== loadAfter) {
  throw new Error("Expected LOAD_AFTER sentinel to remain at the stream edge");
}

const closedNewerEdge = mergeDeletedRows(
  [real("300", "2026-09-14T20:30:00.000Z"), real("400", "2026-09-14T20:40:00.000Z")],
  [records[2]],
  tombstone,
  { hasMoreBefore: true, hasMoreAfter: false },
);
assertIds(closedNewerEdge, ["300", "400", "450"], "closed newer edge");

let refreshes = 0;
const scheduler = createRenderRefreshScheduler(() => refreshes++, 0);
scheduler.request();
scheduler.request();
scheduler.request();
scheduler.request();
scheduler.request();
await new Promise((resolve) => setTimeout(resolve, 10));
if (refreshes !== 1) {
  throw new Error(`Expected rapid refresh requests to coalesce to 1, got ${refreshes}`);
}
scheduler.dispose();

const indexSource = readFileSync("plugins/MessageHistory/src/index.ts", "utf8");
for (const token of [
  "createSyntheticDeletedMessage",
  "injectedDeletedMessages",
  "recentlyPreservedDeletes",
  "consumeSyntheticDeletedDismiss",
  'event.type = "MESSAGE_UPDATE"',
  "event.messages = sortMessagesLikeBatch",
]) {
  if (indexSource.includes(token)) {
    throw new Error(`Forbidden legacy reinjection path remains: ${token}`);
  }
}
for (const token of ['findByName("createChannelStream"', "RecentMessageCache", "mergeDeletedRows"]) {
  if (!indexSource.includes(token)) {
    throw new Error(`Expected redesigned runtime wiring to include: ${token}`);
  }
}

const historySource = readFileSync("plugins/MessageHistory/src/history.ts", "utf8");
const settingsSource = readFileSync("plugins/MessageHistory/src/settings.tsx", "utf8");
const typesSource = readFileSync("plugins/MessageHistory/src/types.ts", "utf8");
const combinedProductionSource = `${indexSource}\n${historySource}\n${settingsSource}\n${typesSource}`;
for (const token of [
  "createSyntheticDeletedCreateEvent",
  "message_history_synthetic_deleted",
  "shouldConsumeSyntheticDeletedDismiss",
  "debugReinject",
  "reinjectDebugEvents",
  "showReinjectDebugModal",
  "recordReinjectDebugEvent",
  "ReinjectDebugEvent",
]) {
  if (combinedProductionSource.includes(token)) {
    throw new Error(`Expected obsolete reinjection/debug surface to be removed: ${token}`);
  }
}
if (historySource.includes("flags: 64")) {
  throw new Error("Expected deleted history to stop using Discord's EPHEMERAL flag");
}
if (existsSync("plugins/MessageHistory/src/debug.tsx")) {
  throw new Error("Expected obsolete reinjection debug module to be deleted");
}
if (!indexSource.includes("bindMessageHistoryRuntime")) {
  throw new Error("Expected settings/runtime invalidation to use the runtime bridge");
}

console.log("message history overlay ok");
