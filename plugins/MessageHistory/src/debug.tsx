import { ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { showConfirmationAlert } from "@vendetta/ui/alerts";
import { Forms } from "@vendetta/ui/components";

import { getEventMessageIdentity, getKindRecords, normalizeSettings } from "./history";
import type { HistoryRecord, ReinjectDebugEvent } from "./types";

const DEBUG_EVENT_LIMIT = 80;
const DEBUG_EVENT_PATTERN = /(MESSAGE|CHANNEL|LOAD|SELECT|CREATE|DELETE|UPDATE|READY)/i;

function readRecords(): HistoryRecord[] {
    return Array.isArray(storage.historyRecords) ? storage.historyRecords : [];
}

export function readReinjectDebugEvents(): ReinjectDebugEvent[] {
    return Array.isArray(storage.reinjectDebugEvents) ? storage.reinjectDebugEvents : [];
}

export function clearReinjectDebugEvents() {
    storage.reinjectDebugEvents = [];
}

function getMessageTimestamp(message: any): string | number | null {
    return message?.timestamp ?? message?.edited_timestamp ?? null;
}

function countSavedDeletesForChannel(channelId?: string | null): number {
    if (!channelId) return 0;

    return getKindRecords({ records: readRecords() }, "delete").filter((record) => record.channelId === channelId).length;
}

function getMessageChannelId(message: any): string | null {
    return message?.channel_id ?? message?.channelId ?? null;
}

function shouldLogEvent(type: string): boolean {
    return Boolean(type && DEBUG_EVENT_PATTERN.test(type));
}

export function recordReinjectDebugEvent(method: string, event: any, extra?: ReinjectDebugEvent["extra"]) {
    if (!normalizeSettings(storage.settings).debugReinject) return;

    const type = typeof event?.type === "string" ? event.type : "unknown";
    if (!shouldLogEvent(type)) return;

    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const firstMessage = messages[0];
    const lastMessage = messages.length ? messages[messages.length - 1] : undefined;
    const identity = getEventMessageIdentity(event);
    const channelId = identity.channelId ?? getMessageChannelId(firstMessage) ?? getMessageChannelId(lastMessage) ?? null;
    const savedDeletesForChannel = countSavedDeletesForChannel(channelId);

    const entry: ReinjectDebugEvent = {
        id: `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        method,
        type,
        channelId,
        messageId: identity.messageId ?? null,
        messageChannelId: getMessageChannelId(event?.message),
        messagesLength: Array.isArray(event?.messages) ? event.messages.length : null,
        firstMessageId: firstMessage?.id ?? null,
        firstMessageTimestamp: getMessageTimestamp(firstMessage),
        lastMessageId: lastMessage?.id ?? null,
        lastMessageTimestamp: getMessageTimestamp(lastMessage),
        hasMessage: Boolean(event?.message),
        hasMessages: Array.isArray(event?.messages),
        hasSavedDeletesForChannel: savedDeletesForChannel > 0,
        savedDeletesForChannel,
        eventKeys: event && typeof event === "object" ? Object.keys(event).slice(0, 24) : [],
        extra,
    };

    storage.reinjectDebugEvents = [entry, ...readReinjectDebugEvents()].slice(0, DEBUG_EVENT_LIMIT);
}

function formatValue(value: unknown): string {
    if (value === null || value === undefined || value === "") return "-";
    return String(value);
}

function formatDebugEvent(event: ReinjectDebugEvent): string {
    const lines = [
        `${new Date(event.timestamp).toLocaleString()} via ${event.method}`,
        `type: ${event.type}`,
        `channelId: ${formatValue(event.channelId)}`,
        `messageId: ${formatValue(event.messageId)}`,
        `messageChannelId: ${formatValue(event.messageChannelId)}`,
        `hasMessage: ${event.hasMessage}`,
        `hasMessages: ${event.hasMessages}`,
        `messagesLength: ${formatValue(event.messagesLength)}`,
        `first: ${formatValue(event.firstMessageId)} @ ${formatValue(event.firstMessageTimestamp)}`,
        `last: ${formatValue(event.lastMessageId)} @ ${formatValue(event.lastMessageTimestamp)}`,
        `savedDeletesForChannel: ${event.savedDeletesForChannel}`,
        `keys: ${event.eventKeys.join(", ") || "-"}`,
    ];

    if (event.extra && Object.keys(event.extra).length) {
        lines.push(`extra: ${Object.entries(event.extra).map(([key, value]) => `${key}=${formatValue(value)}`).join(", ")}`);
    }

    return lines.join("\n");
}

function ReinjectDebugContent({ events }: { events: ReinjectDebugEvent[] }) {
    return (
        <ReactNative.View style={{ alignSelf: "stretch", width: "100%" }}>
            <ReactNative.ScrollView style={{ alignSelf: "stretch", maxHeight: 560, width: "100%" }}>
                <Forms.FormSection title="Reinject Debug Log">
                    {events.length ? (
                        events.map((event) => (
                            <ReactNative.View key={event.id} style={{ alignSelf: "stretch", width: "100%" }}>
                                <Forms.FormRow label={`${event.type} (${event.method})`} subLabel={formatDebugEvent(event)} />
                            </ReactNative.View>
                        ))
                    ) : (
                        <Forms.FormRow label="No debug events" subLabel="Enable debug logging, restart, then reopen this panel." />
                    )}
                </Forms.FormSection>
                <ReactNative.View style={{ height: 24 }} />
            </ReactNative.ScrollView>
        </ReactNative.View>
    );
}

export function showReinjectDebugModal() {
    showConfirmationAlert({
        title: "Reinject Debug Log",
        content: <ReinjectDebugContent events={readReinjectDebugEvents()} />,
        confirmText: "Close",
        onConfirm: () => {},
        isDismissable: true,
    });
}
