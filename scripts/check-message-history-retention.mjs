import {
  addRecord,
  clearMessageKindRecords,
  createRecord,
  createSyntheticDeletedCreateEvent,
  createSyntheticDeletedMessage,
  getEventMessageIdentity,
  getKindRecords,
  getMessageRecords,
  getRecordMessageTimestamp,
  isSyntheticDeletedMessage,
  normalizeSettings,
  pruneRecords,
  shouldConsumeSyntheticDeletedDismiss,
  sortOldestByMessageTime,
} from "../.codex-tmp/MessageHistory/history.mjs";
import { cycleNumericSetting, nextOptionValue, selectNumericSetting } from "../.codex-tmp/MessageHistory/settingsOptions.mjs";

const settings = {
  logEdits: true,
  logDeletes: true,
  persistHistory: true,
  showDeletedInChannelsAfterRestart: false,
  debugReinject: false,
  maxTotalRecords: 200,
  maxRecordsPerChannel: 50,
  maxRecordsPerMessage: 10,
  maxAgeDays: 3,
};

const base = {
  id: "message-1",
  channelId: "channel-1",
  guildId: "guild-1",
  authorId: "user-1",
  authorUsername: "marc",
  content: "version",
  attachments: [],
  embeds: [],
  raw: {},
};

let state = { records: [] };
for (let i = 0; i < 12; i++) {
  state = addRecord(state, createRecord("edit", { ...base, content: `version ${i}` }, 1_000 + i), settings, 1_000 + i);
}

const messageRecords = getMessageRecords(state, "channel-1", "message-1");
if (messageRecords.length !== 10) {
  throw new Error(`Expected per-message limit to keep 10 records, got ${messageRecords.length}`);
}

const expired = createRecord("edit", { ...base, id: "old-message", content: "old" }, 1);
const fresh = createRecord("edit", { ...base, id: "fresh-message", content: "fresh" }, 10 * 24 * 60 * 60 * 1_000);
const pruned = pruneRecords([expired, fresh], settings, 10 * 24 * 60 * 60 * 1_000);
if (pruned.some((record) => record.messageId === "old-message")) {
  throw new Error("Expected age pruning to remove expired records");
}

if (nextOptionValue("maxAgeDays", 3) !== 7) {
  throw new Error("Expected max age to cycle from 3 to 7");
}

if (nextOptionValue("maxTotalRecords", 999) !== 50) {
  throw new Error("Expected unknown total record value to cycle back to the first preset");
}

const displayedSettings = {
  maxTotalRecords: 200,
  maxRecordsPerChannel: 50,
  maxRecordsPerMessage: 10,
  maxAgeDays: 3,
};
const cycledSettings = cycleNumericSetting(displayedSettings, "maxAgeDays");
if (cycledSettings.maxAgeDays !== 7 || displayedSettings.maxAgeDays !== 3) {
  throw new Error("Expected numeric setting cycle to return a new visible settings object");
}

const selectedSettings = selectNumericSetting(displayedSettings, "maxAgeDays", 14);
if (selectedSettings.maxAgeDays !== 14 || displayedSettings.maxAgeDays !== 3) {
  throw new Error("Expected explicit numeric selection to return a new visible settings object");
}

state = addRecord(state, createRecord("delete", { ...base, id: "deleted-message", content: "gone" }, 2_000), settings, 2_000);
const deleteRecords = getKindRecords(state, "delete");
if (deleteRecords.length !== 1 || deleteRecords[0].messageId !== "deleted-message") {
  throw new Error("Expected persisted delete records to be retrievable separately");
}

if (normalizeSettings({}).showDeletedInChannelsAfterRestart !== false) {
  throw new Error("Expected channel reinjection to default off");
}

if (normalizeSettings({}).debugReinject !== false) {
  throw new Error("Expected reinject debugging to default off");
}

const syntheticDelete = createSyntheticDeletedMessage(deleteRecords[0]);
if (
  syntheticDelete.id !== "deleted-message" ||
  syntheticDelete.channel_id !== "channel-1" ||
  syntheticDelete.content !== "[deleted] gone" ||
  syntheticDelete.author.id !== "user-1"
) {
  throw new Error("Expected synthetic deleted message to preserve record identity and content");
}

if (syntheticDelete.message_history_synthetic_deleted !== true) {
  throw new Error("Expected synthetic deleted message to carry a local marker");
}

if (!isSyntheticDeletedMessage(syntheticDelete)) {
  throw new Error("Expected synthetic deleted messages to be recognized by the dismiss guard");
}

if (isSyntheticDeletedMessage({ id: "normal-message", flags: 64, content: "normal ephemeral notice" })) {
  throw new Error("Expected non-history ephemeral messages to stay outside the dismiss guard");
}

if (!shouldConsumeSyntheticDeletedDismiss({ hasSavedDeleteRecord: true, trackedSyntheticMessage: true })) {
  throw new Error("Expected saved synthetic deleted rows to be dismissable");
}

if (shouldConsumeSyntheticDeletedDismiss({ hasSavedDeleteRecord: true, trackedSyntheticMessage: true, protectedRecentDelete: true })) {
  throw new Error("Expected fresh delete echoes to be protected from dismiss cleanup");
}

if (shouldConsumeSyntheticDeletedDismiss({ hasSavedDeleteRecord: false, trackedSyntheticMessage: true })) {
  throw new Error("Expected synthetic-looking rows without saved history to be ignored");
}

const syntheticCreateEvent = createSyntheticDeletedCreateEvent(deleteRecords[0]);
if (
  syntheticCreateEvent.type !== "MESSAGE_CREATE" ||
  syntheticCreateEvent.channelId !== "channel-1" ||
  syntheticCreateEvent.message.id !== "deleted-message" ||
  syntheticCreateEvent.otherPluginBypass !== true
) {
  throw new Error("Expected synthetic deleted record to create a guarded MESSAGE_CREATE event");
}

const nestedDeleteIdentity = getEventMessageIdentity({
  type: "MESSAGE_DELETE",
  message: {
    id: "nested-message",
    channel_id: "nested-channel",
  },
});
if (nestedDeleteIdentity.channelId !== "nested-channel" || nestedDeleteIdentity.messageId !== "nested-message") {
  throw new Error("Expected delete handling to normalize nested message ids");
}

const topLevelDeleteIdentity = getEventMessageIdentity({
  type: "MESSAGE_DELETE",
  id: "top-level-message",
  channelId: "top-level-channel",
});
if (topLevelDeleteIdentity.channelId !== "top-level-channel" || topLevelDeleteIdentity.messageId !== "top-level-message") {
  throw new Error("Expected delete handling to keep top-level message ids");
}

const originalMessageTimestamp = "2026-05-31T16:09:00.000Z";
const deleteLoggedAt = Date.parse("2026-05-31T16:54:00.000Z");
const timestampedDeleteRecord = createRecord(
  "delete",
  {
    ...base,
    id: "timestamped-delete",
    content: "old spot",
    timestamp: originalMessageTimestamp,
  },
  deleteLoggedAt,
);
if (timestampedDeleteRecord.messageTimestamp !== Date.parse(originalMessageTimestamp)) {
  throw new Error("Expected delete records to retain the original message timestamp");
}

const timestampedSyntheticDelete = createSyntheticDeletedMessage(timestampedDeleteRecord);
if (timestampedSyntheticDelete.timestamp !== originalMessageTimestamp) {
  throw new Error("Expected synthetic deleted messages to display at the original message timestamp");
}

const discordEpoch = 1_420_070_400_000n;
const snowflakeTimestamp = 1_600_000_000_000n;
const snowflakeId = String((snowflakeTimestamp - discordEpoch) << 22n);
if (getRecordMessageTimestamp({ ...deleteRecords[0], messageId: snowflakeId, messageTimestamp: undefined }) !== Number(snowflakeTimestamp)) {
  throw new Error("Expected missing message timestamps to fall back to the Discord snowflake timestamp");
}

const olderRecord = createRecord("delete", { ...base, id: "older", timestamp: "2026-05-31T16:00:00.000Z" }, deleteLoggedAt + 2);
const newerRecord = createRecord("delete", { ...base, id: "newer", timestamp: "2026-05-31T17:00:00.000Z" }, deleteLoggedAt + 1);
const sortedByMessageTime = sortOldestByMessageTime([newerRecord, olderRecord]);
if (sortedByMessageTime[0].messageId !== "older" || sortedByMessageTime[1].messageId !== "newer") {
  throw new Error("Expected reinjected records to sort by original message time from oldest to newest");
}

const mixedState = {
  records: [
    createRecord("edit", { ...base, id: "mixed-message", content: "edit" }, 3_000),
    createRecord("delete", { ...base, id: "mixed-message", content: "delete" }, 4_000),
    createRecord("delete", { ...base, id: "other-message", content: "other" }, 5_000),
  ],
};
const deleteClearedState = clearMessageKindRecords(mixedState, "channel-1", "mixed-message", "delete");
if (getKindRecords(deleteClearedState, "delete").some((record) => record.messageId === "mixed-message")) {
  throw new Error("Expected dismiss cleanup to remove delete records for the dismissed message");
}
if (!getKindRecords(deleteClearedState, "edit").some((record) => record.messageId === "mixed-message")) {
  throw new Error("Expected dismiss cleanup to keep edit records for the dismissed message");
}
if (!getKindRecords(deleteClearedState, "delete").some((record) => record.messageId === "other-message")) {
  throw new Error("Expected dismiss cleanup to keep other messages' delete records");
}

console.log("message history retention ok");
