import {
  addRecord,
  createRecord,
  createSyntheticDeletedMessage,
  getKindRecords,
  getMessageRecords,
  normalizeSettings,
  pruneRecords,
} from "../.codex-tmp/MessageHistory/history.mjs";
import { cycleNumericSetting, nextOptionValue, selectNumericSetting } from "../.codex-tmp/MessageHistory/settingsOptions.mjs";

const settings = {
  logEdits: true,
  logDeletes: true,
  persistHistory: true,
  showDeletedInChannelsAfterRestart: false,
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

const syntheticDelete = createSyntheticDeletedMessage(deleteRecords[0]);
if (
  syntheticDelete.id !== "deleted-message" ||
  syntheticDelete.channel_id !== "channel-1" ||
  syntheticDelete.content !== "[deleted] gone" ||
  syntheticDelete.author.id !== "user-1"
) {
  throw new Error("Expected synthetic deleted message to preserve record identity and content");
}

console.log("message history retention ok");
