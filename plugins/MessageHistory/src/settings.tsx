import { ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { showConfirmationAlert, showInputAlert } from "@vendetta/ui/alerts";
import { ErrorBoundary, Forms } from "@vendetta/ui/components";

import { DEFAULT_SETTINGS, normalizeSettings, pruneRecords } from "./history";
import type { MessageHistorySettings } from "./types";

type NumericSetting = "maxTotalRecords" | "maxRecordsPerChannel" | "maxRecordsPerMessage" | "maxAgeDays";

function readSettings(): MessageHistorySettings {
    const settings = normalizeSettings(storage.settings);
    storage.settings = settings;
    storage.historyRecords = pruneRecords(Array.isArray(storage.historyRecords) ? storage.historyRecords : [], settings);
    return settings;
}

function writeSettings(settings: Partial<MessageHistorySettings>) {
    const nextSettings = normalizeSettings({ ...storage.settings, ...settings });
    storage.settings = nextSettings;
    storage.historyRecords = pruneRecords(Array.isArray(storage.historyRecords) ? storage.historyRecords : [], nextSettings);
}

function setNumber(key: NumericSetting, title: string) {
    const settings = readSettings();

    showInputAlert({
        title,
        placeholder: String(DEFAULT_SETTINGS[key]),
        initialValue: String(settings[key]),
        confirmText: "Save",
        onConfirm: (value) => {
            writeSettings({ [key]: Number(value) });
        },
    });
}

function clearHistory() {
    showConfirmationAlert({
        title: "Clear Message History",
        content: "Remove all saved edit and delete history for this plugin?",
        confirmText: "Clear",
        cancelText: "Cancel",
        onConfirm: () => {
            storage.historyRecords = [];
        },
    });
}

export default function Settings() {
    useProxy(storage);

    const settings = readSettings();
    const records = Array.isArray(storage.historyRecords) ? storage.historyRecords : [];

    return (
        <ErrorBoundary>
            <ReactNative.ScrollView>
                <Forms.FormSwitchRow
                    label="Log edits"
                    subLabel="Keep previous versions when messages are edited"
                    value={settings.logEdits}
                    onValueChange={(value) => writeSettings({ logEdits: value })}
                />
                <Forms.FormSwitchRow
                    label="Log deletes"
                    subLabel="Keep deleted messages visible locally"
                    value={settings.logDeletes}
                    onValueChange={(value) => writeSettings({ logDeletes: value })}
                />
                <Forms.FormSwitchRow
                    label="Persist history"
                    subLabel="Keep history after closing the app"
                    value={settings.persistHistory}
                    onValueChange={(value) => writeSettings({ persistHistory: value })}
                />
                <Forms.FormRow
                    label="Max total records"
                    subLabel={String(settings.maxTotalRecords)}
                    onPress={() => setNumber("maxTotalRecords", "Max total records")}
                />
                <Forms.FormRow
                    label="Max records per channel"
                    subLabel={String(settings.maxRecordsPerChannel)}
                    onPress={() => setNumber("maxRecordsPerChannel", "Max records per channel")}
                />
                <Forms.FormRow
                    label="Max records per message"
                    subLabel={String(settings.maxRecordsPerMessage)}
                    onPress={() => setNumber("maxRecordsPerMessage", "Max records per message")}
                />
                <Forms.FormRow
                    label="Max age in days"
                    subLabel={String(settings.maxAgeDays)}
                    onPress={() => setNumber("maxAgeDays", "Max age in days")}
                />
                <Forms.FormRow
                    label="Clear all history"
                    subLabel={`${records.length} saved records`}
                    onPress={clearHistory}
                />
            </ReactNative.ScrollView>
        </ErrorBoundary>
    );
}
