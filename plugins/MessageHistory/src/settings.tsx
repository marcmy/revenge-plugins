import { React, ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { showConfirmationAlert } from "@vendetta/ui/alerts";
import { ErrorBoundary, Forms } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";

import { clearReinjectDebugEvents, readReinjectDebugEvents, showReinjectDebugModal } from "./debug";
import { getKindRecords, normalizeSettings } from "./history";
import { selectNumericSetting, SETTING_OPTIONS, type NumericSetting } from "./settingsOptions";
import type { HistoryRecord, MessageHistorySettings } from "./types";
import { showHistoryModal } from "./ui";

function readSettings(): MessageHistorySettings {
    return normalizeSettings(storage.settings);
}

function readRecordCount(): number {
    return Array.isArray(storage.historyRecords) ? storage.historyRecords.length : 0;
}

function readDebugEventCount(): number {
    return readReinjectDebugEvents().length;
}

function readRecords(): HistoryRecord[] {
    return Array.isArray(storage.historyRecords) ? storage.historyRecords : [];
}

function persistSettings(nextSettings: MessageHistorySettings) {
    storage.settings = nextSettings;
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

function clearReinjectDebugLog(onCleared: () => void) {
    showConfirmationAlert({
        title: "Clear Reinject Debug Log",
        content: "Remove all saved reinjection debug events?",
        confirmText: "Clear",
        cancelText: "Cancel",
        onConfirm: () => {
            clearReinjectDebugEvents();
            onCleared();
        },
    });
}

function optionLabel(key: NumericSetting, value: number): string {
    if (key === "maxAgeDays") return `${value} ${value === 1 ? "day" : "days"}`;
    return `${value} records`;
}

function settingLabel(key: NumericSetting): string {
    const labels: Record<NumericSetting, string> = {
        maxTotalRecords: "Max total records",
        maxRecordsPerChannel: "Max records per channel",
        maxRecordsPerMessage: "Max records per message",
        maxAgeDays: "Max age",
    };

    return labels[key];
}

function OptionPickerContent({
    current,
    onSelect,
    settingKey,
}: {
    current: number;
    onSelect: (value: number) => void;
    settingKey: NumericSetting;
}) {
    const [selected, setSelected] = React.useState(current);
    const checkIcon = getAssetIDByName("ic_check_24px") || getAssetIDByName("Check");

    return (
        <ReactNative.View style={{ alignSelf: "stretch", width: "100%" }}>
            <Forms.FormSection title={settingLabel(settingKey)}>
                {SETTING_OPTIONS[settingKey].map((value) => (
                    <Forms.FormRow
                        key={value}
                        label={optionLabel(settingKey, value)}
                        subLabel={selected === value ? "Selected" : undefined}
                        trailing={selected === value ? <Forms.FormRow.Icon source={checkIcon} /> : undefined}
                        onPress={() => {
                            setSelected(value);
                            onSelect(value);
                        }}
                    />
                ))}
            </Forms.FormSection>
        </ReactNative.View>
    );
}

export default function Settings() {
    const [settings, setSettings] = React.useState(readSettings);
    const [recordCount, setRecordCount] = React.useState(readRecordCount);
    const [debugEventCount, setDebugEventCount] = React.useState(readDebugEventCount);

    const updateSettings = React.useCallback((patch: Partial<MessageHistorySettings>) => {
        const nextSettings = normalizeSettings({ ...settings, ...patch });
        persistSettings(nextSettings);
        setSettings(nextSettings);
        setRecordCount(readRecordCount());
        setDebugEventCount(readDebugEventCount());
    }, [settings]);

    const selectNumber = React.useCallback((key: NumericSetting, value: number) => {
        const nextSettings = normalizeSettings(selectNumericSetting(settings, key, value));
        persistSettings(nextSettings);
        setSettings(nextSettings);
        setRecordCount(readRecordCount());
        setDebugEventCount(readDebugEventCount());
    }, [settings]);

    const showOptionPicker = React.useCallback((key: NumericSetting) => {
        showConfirmationAlert({
            title: settingLabel(key),
            content: <OptionPickerContent current={settings[key]} onSelect={(value) => selectNumber(key, value)} settingKey={key} />,
            confirmText: "Close",
            onConfirm: () => {},
            isDismissable: true,
        });
    }, [selectNumber, settings]);

    const arrow = () => <Forms.FormRow.Icon source={getAssetIDByName("ic_arrow_right")} />;
    const records = readRecords();
    const deletedRecords = getKindRecords({ records }, "delete");

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
                <Forms.FormSwitchRow
                    label="Show saved deletes in channels"
                    subLabel="After restart, softly restore saved deleted messages in loaded channels"
                    value={settings.showDeletedInChannelsAfterRestart}
                    onValueChange={(value) => updateSettings({ showDeletedInChannelsAfterRestart: value })}
                />
                <Forms.FormSwitchRow
                    label="Debug reinjection"
                    subLabel="Record message-load event shapes for troubleshooting restart reinjection"
                    value={settings.debugReinject}
                    onValueChange={(value) => updateSettings({ debugReinject: value })}
                />
                <Forms.FormRow
                    label="Max total records"
                    subLabel={`${settings.maxTotalRecords} saved records. Tap to choose.`}
                    trailing={arrow()}
                    onPress={() => showOptionPicker("maxTotalRecords")}
                />
                <Forms.FormRow
                    label="Max records per channel"
                    subLabel={`${settings.maxRecordsPerChannel} saved records. Tap to choose.`}
                    trailing={arrow()}
                    onPress={() => showOptionPicker("maxRecordsPerChannel")}
                />
                <Forms.FormRow
                    label="Max records per message"
                    subLabel={`${settings.maxRecordsPerMessage} saved records. Tap to choose.`}
                    trailing={arrow()}
                    onPress={() => showOptionPicker("maxRecordsPerMessage")}
                />
                <Forms.FormRow
                    label="Max age in days"
                    subLabel={`${settings.maxAgeDays} days. Tap to choose.`}
                    trailing={arrow()}
                    onPress={() => showOptionPicker("maxAgeDays")}
                />
                <Forms.FormRow
                    label="Browse saved history"
                    subLabel={`${recordCount} saved records`}
                    trailing={arrow()}
                    onPress={() => showHistoryModal(records, "Saved History")}
                />
                <Forms.FormRow
                    label="Browse deleted messages"
                    subLabel={`${deletedRecords.length} saved deleted messages`}
                    trailing={arrow()}
                    onPress={() => showHistoryModal(deletedRecords, "Deleted Messages")}
                />
                <Forms.FormRow
                    label="Browse reinject debug log"
                    subLabel={`${debugEventCount} captured events`}
                    trailing={arrow()}
                    onPress={() => {
                        setDebugEventCount(readDebugEventCount());
                        showReinjectDebugModal();
                    }}
                />
                <Forms.FormRow
                    label="Clear reinject debug log"
                    subLabel={`${debugEventCount} captured events`}
                    onPress={() => clearReinjectDebugLog(() => setDebugEventCount(0))}
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
