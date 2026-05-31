import { React, ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { showConfirmationAlert } from "@vendetta/ui/alerts";
import { ErrorBoundary, Forms } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";

import { normalizeSettings, pruneRecords } from "./history";
import { cycleNumericSetting, type NumericSetting } from "./settingsOptions";
import type { MessageHistorySettings } from "./types";

function readSettings(): MessageHistorySettings {
    return normalizeSettings(storage.settings);
}

function readRecordCount(): number {
    return Array.isArray(storage.historyRecords) ? storage.historyRecords.length : 0;
}

function persistSettings(nextSettings: MessageHistorySettings) {
    storage.settings = nextSettings;
    storage.historyRecords = pruneRecords(Array.isArray(storage.historyRecords) ? storage.historyRecords : [], nextSettings);
}

function clearHistory(onCleared: () => void) {
    showConfirmationAlert({
        title: "Clear Message History",
        content: "Remove all saved edit and delete history for this plugin?",
        confirmText: "Clear",
        cancelText: "Cancel",
        onConfirm: () => {
            storage.historyRecords = [];
            onCleared();
        },
    });
}

export default function Settings() {
    const [settings, setSettings] = React.useState(readSettings);
    const [recordCount, setRecordCount] = React.useState(readRecordCount);

    const updateSettings = React.useCallback((patch: Partial<MessageHistorySettings>) => {
        const nextSettings = normalizeSettings({ ...settings, ...patch });
        persistSettings(nextSettings);
        setSettings(nextSettings);
        setRecordCount(readRecordCount());
    }, [settings]);

    const cycleNumber = React.useCallback((key: NumericSetting) => {
        const nextSettings = normalizeSettings(cycleNumericSetting(settings, key));
        persistSettings(nextSettings);
        setSettings(nextSettings);
        setRecordCount(readRecordCount());
    }, [settings]);

    const arrow = () => <Forms.FormRow.Icon source={getAssetIDByName("ic_arrow_right")} />;

    return (
        <ErrorBoundary>
            <ReactNative.ScrollView>
                <Forms.FormSwitchRow
                    label="Log edits"
                    subLabel="Keep previous versions when messages are edited"
                    value={settings.logEdits}
                    onValueChange={(value) => updateSettings({ logEdits: value })}
                />
                <Forms.FormSwitchRow
                    label="Log deletes"
                    subLabel="Keep deleted messages visible locally"
                    value={settings.logDeletes}
                    onValueChange={(value) => updateSettings({ logDeletes: value })}
                />
                <Forms.FormSwitchRow
                    label="Persist history"
                    subLabel="Keep history after closing the app"
                    value={settings.persistHistory}
                    onValueChange={(value) => updateSettings({ persistHistory: value })}
                />
                <Forms.FormRow
                    label="Max total records"
                    subLabel={`${settings.maxTotalRecords} saved records. Tap to change.`}
                    trailing={arrow()}
                    onPress={() => cycleNumber("maxTotalRecords")}
                />
                <Forms.FormRow
                    label="Max records per channel"
                    subLabel={`${settings.maxRecordsPerChannel} saved records. Tap to change.`}
                    trailing={arrow()}
                    onPress={() => cycleNumber("maxRecordsPerChannel")}
                />
                <Forms.FormRow
                    label="Max records per message"
                    subLabel={`${settings.maxRecordsPerMessage} saved records. Tap to change.`}
                    trailing={arrow()}
                    onPress={() => cycleNumber("maxRecordsPerMessage")}
                />
                <Forms.FormRow
                    label="Max age in days"
                    subLabel={`${settings.maxAgeDays} days. Tap to change.`}
                    trailing={arrow()}
                    onPress={() => cycleNumber("maxAgeDays")}
                />
                <Forms.FormRow
                    label="Clear all history"
                    subLabel={`${recordCount} saved records`}
                    onPress={() => clearHistory(() => setRecordCount(0))}
                />
            </ReactNative.ScrollView>
        </ErrorBoundary>
    );
}
