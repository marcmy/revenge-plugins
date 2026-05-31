import { findByProps } from "@vendetta/metro";
import { ReactNative } from "@vendetta/metro/common";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showConfirmationAlert } from "@vendetta/ui/alerts";
import { Forms } from "@vendetta/ui/components";

import type { HistoryRecord } from "./types";

const actionSheetComponents = findByProps("ActionSheetRow");

function formatTime(timestamp: number): string {
    try {
        return new Date(timestamp).toLocaleString();
    } catch {
        return String(timestamp);
    }
}

function recordTitle(record: HistoryRecord): string {
    return record.kind === "delete" ? "Deleted message" : "Previous edit";
}

function HistoryContent({ records }: { records: HistoryRecord[] }) {
    return (
        <ReactNative.ScrollView style={{ maxHeight: 520 }}>
            <Forms.FormSection title="Message History">
                {records.map((record) => (
                    <Forms.FormRow
                        key={record.id}
                        label={recordTitle(record)}
                        subLabel={`${formatTime(record.timestamp)}${record.content ? `\n${record.content}` : ""}`}
                    />
                ))}
            </Forms.FormSection>
            <ReactNative.View style={{ height: 24 }} />
        </ReactNative.ScrollView>
    );
}

export function showHistoryModal(records: HistoryRecord[]) {
    showConfirmationAlert({
        title: "Message History",
        content: <HistoryContent records={records} />,
        confirmText: "Close",
        onConfirm: () => {},
        isDismissable: true,
    });
}

export function createActionSheetRow(label: string, subLabel: string, onPress: () => void) {
    const ActionSheetRow = actionSheetComponents?.ActionSheetRow;
    const icon = getAssetIDByName("ic_history_24px") || getAssetIDByName("ic_edit_24px");

    if (ActionSheetRow) {
        return (
            <ActionSheetRow
                label={label}
                subLabel={subLabel}
                icon={<ActionSheetRow.Icon source={icon} />}
                onPress={onPress}
            />
        );
    }

    return (
        <Forms.FormRow
            label={label}
            subLabel={subLabel}
            leading={<Forms.FormRow.Icon source={icon} />}
            onPress={onPress}
        />
    );
}
