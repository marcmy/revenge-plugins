import {
  addRecord,
  createRecord,
  dedupeDeleteRecordsByMessage,
  getInlineDeleteRecords,
  getKindRecords,
  normalizeHistoryRecord,
  setDeleteInlineHidden,
} from "../.codex-tmp/MessageHistory/history.mjs";

const settings = {
  logEdits: true,
  logDeletes: true,
  persistHistory: true,
  showDeletedInChannelsAfterRestart: true,
  debugReinject: false,
  maxTotalRecords: 200,
  maxRecordsPerChannel: 50,
  maxRecordsPerMessage: 10,
  maxAgeDays: 3,
};

const base = {
  id: "deleted-message",
  channelId: "channel-1",
  guildId: "guild-1",
  authorId: "user-1",
  authorUsername: "marc",
  content: "gone",
  attachments: [],
  embeds: [],
  timestamp: "2026-09-14T20:00:00.000Z",
  raw: {},
};

const deleteRecord = createRecord("delete", base, Date.parse("2026-09-14T20:05:00.000Z"));
const legacyDelete = { ...deleteRecord };
delete legacyDelete.inlineHidden;
const normalizedLegacy = normalizeHistoryRecord(legacyDelete);
if (normalizedLegacy.inlineHidden !== false) {
  throw new Error("Expected legacy delete records to migrate inlineHidden=false");
}

let state = addRecord({ records: [] }, normalizedLegacy, settings, normalizedLegacy.timestamp);
if (getInlineDeleteRecords(state, "channel-1").length !== 1) {
  throw new Error("Expected a visible saved delete to be an inline candidate");
}

state = setDeleteInlineHidden(state, "channel-1", "deleted-message", true);
if (getInlineDeleteRecords(state, "channel-1").length !== 0) {
  throw new Error("Expected inline-hidden deletes to stay out of overlay candidates");
}
if (getKindRecords(state, "delete").length !== 1) {
  throw new Error("Expected inline-hidden deletes to remain saved in history");
}

const duplicateDelete = {
  ...normalizedLegacy,
  id: `${normalizedLegacy.id}:duplicate`,
  timestamp: normalizedLegacy.timestamp + 1,
};
const deduped = dedupeDeleteRecordsByMessage([normalizedLegacy, duplicateDelete]);
if (deduped.length !== 1 || deduped[0].id !== duplicateDelete.id) {
  throw new Error("Expected newest delete record to win legacy duplicate dedupe");
}

console.log("message history visibility ok");
