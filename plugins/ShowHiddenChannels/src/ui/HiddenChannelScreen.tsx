import { ReactNative } from "@vendetta/metro/common";
import { showConfirmationAlert } from "@vendetta/ui/alerts";
import { Forms } from "@vendetta/ui/components";

import { getHiddenChannelMetadata } from "../core/hiddenChannel";

function formatTime(timestamp: number | null): string {
    if (timestamp == null) return "Not available";
    try {
        return new Date(timestamp).toLocaleString();
    } catch {
        return String(timestamp);
    }
}

export default function HiddenChannelScreen({ channel }: { channel: any }) {
    const metadata = getHiddenChannelMetadata(channel);

    if (!metadata) {
        return (
            <ReactNative.ScrollView style={{ alignSelf: "stretch", maxHeight: 520, width: "100%" }}>
                <Forms.FormSection title="Hidden channel">
                    <Forms.FormRow
                        label="Channel unavailable"
                        subLabel="Discord did not provide enough local metadata to display this channel."
                    />
                </Forms.FormSection>
            </ReactNative.ScrollView>
        );
    }

    return (
        <ReactNative.ScrollView style={{ alignSelf: "stretch", maxHeight: 520, width: "100%" }}>
            <Forms.FormSection title={metadata.name}>
                <Forms.FormRow
                    label="Access"
                    subLabel={`This is an inaccessible ${metadata.typeLabel} channel. Messages are not loaded by this plugin.`}
                />
                <Forms.FormRow label="Channel type" subLabel={metadata.typeLabel} />
                <Forms.FormRow label="Topic" subLabel={metadata.topic} />
                <Forms.FormRow label="Created" subLabel={formatTime(metadata.createdAt)} />
                <Forms.FormRow label="Last message" subLabel={formatTime(metadata.lastMessageAt)} />
                <Forms.FormRow label="Last pin" subLabel={formatTime(metadata.lastPinAt)} />
            </Forms.FormSection>
            <ReactNative.View style={{ height: 16 }} />
        </ReactNative.ScrollView>
    );
}

export function showHiddenChannelInfo(channel: any) {
    const metadata = getHiddenChannelMetadata(channel);
    showConfirmationAlert({
        title: metadata?.name ?? "Hidden channel",
        content: <HiddenChannelScreen channel={channel} />,
        confirmText: "Close",
        onConfirm: () => {},
        isDismissable: true,
    });
}
