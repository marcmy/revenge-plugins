import { ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { showConfirmationAlert } from "@vendetta/ui/alerts";
import { ErrorBoundary, Forms } from "@vendetta/ui/components";

import { normalizeSettings, pruneRecords } from "./history";
import { nextOptionValue, type NumericSetting } from "./settingsOptions";
import type { MessageHistorySettings } from "./types";

function readSettings(): MessageHistorySettings {
    return normalizeSettings(storage.settings);
}

function writeSettings(settings: Partial<MessageHistorySettings>) {
    const nextSettings = normalizeSettings({ ...storage.settings, ...settings });
    storage.settings = nextSettings;
    storage.historyRecords = pruneRecords(Array.isArray(storage.historyRecords) ? storage.historyRecords : [], nextSettings);
}

function cycleNumber(key: NumericSetting) {
    const settings = readSettings();
    writeSettings({ [key]: nextOptionValue(key, settings[key]) });
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
                    subLabel={`${settings.maxTotalRecords} saved records. Tap to change.`}
                    onPress={() => cycleNumber("maxTotalRecords")}
                />
                <Forms.FormRow
                    label="Max records per channel"
                    subLabel={`${settings.maxRecordsPerChannel} saved records. Tap to change.`}
                    onPress={() => cycleNumber("maxRecordsPerChannel")}
                />
                <Forms.FormRow
                    label="Max records per message"
                    subLabel={`${settings.maxRecordsPerMessage} saved records. Tap to change.`}
                    onPress={() => cycleNumber("maxRecordsPerMessage")}
                />
                <Forms.FormRow
                    label="Max age in days"
                    subLabel={`${settings.maxAgeDays} days. Tap to change.`}
                    onPress={() => cycleNumber("maxAgeDays")}
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
