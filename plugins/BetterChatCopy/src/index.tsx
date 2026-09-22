import { findByProps, findByStoreName } from "@vendetta/metro";
import { React, ReactNative } from "@vendetta/metro/common";
import { before, after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { semanticColors } from "@vendetta/ui";
import { showConfirmationAlert } from "@vendetta/ui/alerts";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";
import { findInReactTree } from "@vendetta/utils";

type CopyDirection = "up" | "down";

type Settings = {
    defaultMessageCount: number;
    includeTimestamps: boolean;
    includeAttachments: boolean;
};

const DEFAULT_SETTINGS: Settings = {
    defaultMessageCount: 100,
    includeTimestamps: true,
    includeAttachments: true,
};

const MAX_MESSAGES = 2000;
const TEXT_NORMAL = (semanticColors as any).TEXT_NORMAL ?? "#dbdee1";
const TEXT_MUTED = (semanticColors as any).TEXT_MUTED ?? (semanticColors as any).TEXT_LOW_CONTRAST ?? "#949ba4";
const FETCH_BATCH_SIZE = 100;
const unpatches: Array<() => void> = [];

const ActionSheet = findByProps("openLazy", "hideActionSheet");
const ChannelStore = findByStoreName("ChannelStore") ?? findByProps("getChannel", "getDMFromUserId");
const MessageStore = findByStoreName("MessageStore") ?? findByProps("getMessage", "getMessages");
const UserStore = findByStoreName("UserStore") ?? findByProps("getUser", "getCurrentUser");
const GuildMemberStore = findByProps("getMember", "getNick");
const GuildRoleStore = findByProps("getRole", "getRoles");
const MessageActions = findByProps("fetchMessages", "jumpToMessage");
const Clipboard = findByProps("setString", "getString") ?? (ReactNative as any).Clipboard;
const actionSheetComponents = findByProps("ActionSheetRow");

function readSettings(): Settings {
    const raw = storage.settings ?? {};
    const count = Number(raw.defaultMessageCount);

    return {
        defaultMessageCount: Number.isFinite(count) ? Math.max(1, Math.min(MAX_MESSAGES, Math.round(count))) : DEFAULT_SETTINGS.defaultMessageCount,
        includeTimestamps: raw.includeTimestamps !== false,
        includeAttachments: raw.includeAttachments !== false,
    };
}

function persistSettings(next: Settings) {
    storage.settings = next;
}

function clampCount(value: string | number): number {
    const count = Number(value);
    if (!Number.isFinite(count)) return readSettings().defaultMessageCount;
    return Math.max(1, Math.min(MAX_MESSAGES, Math.round(count)));
}

function snowflakeTimestamp(id?: string): number {
    if (!id || !/^\d+$/.test(id)) return 0;
    try {
        return Number((BigInt(id) >> 22n) + 1420070400000n);
    } catch {
        const numeric = Number(id);
        return Number.isFinite(numeric) ? Math.floor(numeric / 4_194_304) + 1_420_070_400_000 : 0;
    }
}

function messageTimestampMs(message: any): number {
    const ts = message?.timestamp ?? message?.edited_timestamp;
    if (ts instanceof Date) return ts.getTime();
    if (typeof ts === "number" && Number.isFinite(ts)) return ts;
    if (typeof ts === "string") {
        const parsed = Date.parse(ts);
        if (Number.isFinite(parsed)) return parsed;
    }
    return snowflakeTimestamp(message?.id);
}

function sortMessages(messages: any[]): any[] {
    return [...messages].sort((a, b) => messageTimestampMs(a) - messageTimestampMs(b));
}

function dedupeMessages(messages: any[]): any[] {
    const byId = new Map<string, any>();
    for (const message of messages) {
        if (message?.id) byId.set(message.id, message);
    }
    return sortMessages([...byId.values()]);
}

function getAuthorName(message: any): string {
    const author = message?.author;
    if (!author) return "Unknown";

    const user = UserStore?.getUser?.(author.id) ?? author;
    const channel = ChannelStore?.getChannel?.(message.channel_id ?? message.channelId);
    const guildId = channel?.guild_id ?? message.guild_id;
    const member = guildId && GuildMemberStore?.getMember?.(guildId, author.id);
    return member?.nick ?? user?.globalName ?? user?.global_name ?? user?.username ?? author?.globalName ?? author?.global_name ?? author?.username ?? "Unknown";
}

function getTimestampLabel(message: any): string {
    const ms = messageTimestampMs(message);
    if (!ms) return "";
    try {
        return new Date(ms).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch {
        return "";
    }
}

function formatMentions(content: string, channelId: string): string {
    const guildId = ChannelStore?.getChannel?.(channelId)?.guild_id;

    return String(content ?? "")
        .replace(/<@!?(\d+)>/g, (_match, id) => {
            const user = UserStore?.getUser?.(id);
            return user ? `@${user.globalName ?? user.global_name ?? user.username}` : `@${id}`;
        })
        .replace(/<#(\d+)>/g, (_match, id) => {
            const channel = ChannelStore?.getChannel?.(id);
            return channel?.name ? `#${channel.name}` : `#${id}`;
        })
        .replace(/<@&(\d+)>/g, (_match, id) => {
            const role = guildId ? GuildRoleStore?.getRole?.(guildId, id) : null;
            return role?.name ? `@${role.name}` : `@${id}`;
        })
        .replace(/<a?:([^:]+):\d+>/g, ":$1:");
}

function formatBody(message: any, channelId: string): string {
    const settings = readSettings();
    const parts = [formatMentions(message?.content ?? "", channelId).trim()];

    if (settings.includeAttachments) {
        for (const attachment of message?.attachments ?? []) {
            const url = attachment?.url ?? attachment?.proxy_url;
            if (url) parts.push(`[Attachment: ${url}]`);
        }
    }

    return parts.filter(Boolean).join("\n");
}

function formatConversation(messages: any[], channelId: string): string {
    const settings = readSettings();
    const lines: string[] = [];
    let lastAuthorId: string | undefined;
    let lastMinute = -1;

    for (const message of sortMessages(messages)) {
        const authorId = message?.author?.id;
        const minute = Math.floor(messageTimestampMs(message) / 60000);
        const body = formatBody(message, channelId);

        if (authorId !== lastAuthorId || minute !== lastMinute) {
            const author = getAuthorName(message);
            const time = getTimestampLabel(message);
            lines.push(settings.includeTimestamps && time ? `${author} — ${time}` : author);
            lastAuthorId = authorId;
            lastMinute = minute;
        }

        if (body) lines.push(body);
    }

    return lines.join("\n").trim();
}

function getMessagesArray(channelId: string): any[] {
    try {
        const messages = MessageStore?.getMessages?.(channelId);
        const array = messages?.toArray?.() ?? messages?._array ?? messages;
        return Array.isArray(array) ? array : [];
    } catch {
        return [];
    }
}

function looksLikeMessage(value: any): boolean {
    return !!value && typeof value === "object" && typeof value.id === "string" && (typeof value.content === "string" || value.author);
}

function extractMessages(value: any, depth = 0): any[] {
    if (depth > 5 || value == null) return [];
    if (Array.isArray(value)) {
        if (value.some(looksLikeMessage)) return value.filter(looksLikeMessage);
        for (const item of value) {
            const nested = extractMessages(item, depth + 1);
            if (nested.length) return nested;
        }
        return [];
    }

    if (typeof value !== "object") return [];
    for (const key of ["messages", "body", "data", "result"]) {
        const nested = extractMessages(value[key], depth + 1);
        if (nested.length) return nested;
    }
    return [];
}

function compareSnowflakes(a?: string, b?: string): number {
    if (!a || !b) return 0;
    try {
        const aa = BigInt(a);
        const bb = BigInt(b);
        return aa < bb ? -1 : aa > bb ? 1 : 0;
    } catch {
        return messageTimestampMs({ id: a }) - messageTimestampMs({ id: b });
    }
}

async function fetchBatch(channelId: string, cursor: string, direction: CopyDirection, limit: number): Promise<any[]> {
    if (!MessageActions?.fetchMessages) throw new Error("Discord fetchMessages module is unavailable");

    const args: any = { channelId, limit };
    args[direction === "up" ? "before" : "after"] = cursor;

    const result = await MessageActions.fetchMessages(args);
    const direct = extractMessages(result);
    if (direct.length) return dedupeMessages(direct);

    const fromStore = getMessagesArray(channelId).filter((message) => {
        const cmp = compareSnowflakes(message?.id, cursor);
        return direction === "up" ? cmp < 0 : cmp > 0;
    });

    return dedupeMessages(fromStore)
        .sort((a, b) => direction === "up" ? messageTimestampMs(b) - messageTimestampMs(a) : messageTimestampMs(a) - messageTimestampMs(b))
        .slice(0, limit);
}

async function fetchConversation(channelId: string, anchorMessage: any, direction: CopyDirection, count: number): Promise<any[]> {
    const wanted = clampCount(count);
    const collected = [anchorMessage];
    let cursor = anchorMessage.id;

    while (collected.length < wanted) {
        const limit = Math.min(FETCH_BATCH_SIZE, wanted - collected.length);
        const batch = await fetchBatch(channelId, cursor, direction, limit);
        if (!batch.length) break;

        const filtered = batch.filter((message) => message?.id !== anchorMessage.id && !collected.some((existing) => existing?.id === message?.id));
        if (!filtered.length) break;

        collected.push(...filtered);
        const ordered = sortMessages(filtered);
        cursor = direction === "up" ? ordered[0].id : ordered[ordered.length - 1].id;
        if (filtered.length < limit) break;
    }

    return dedupeMessages(collected).slice(direction === "up" ? -wanted : 0, direction === "up" ? undefined : wanted);
}

function copyText(text: string, toast = "Copied conversation text") {
    if (!text) return;
    try {
        Clipboard?.setString?.(text);
        showToast(toast);
    } catch (error) {
        console.error("[BetterChatCopy] clipboard failed", error);
        showToast("BetterChatCopy: clipboard unavailable");
    }
}

function createActionSheetRow(label: string, subLabel: string, onPress: () => void) {
    const ActionSheetRow = actionSheetComponents?.ActionSheetRow;
    const icon = getAssetIDByName("ic_copy_24px") || getAssetIDByName("Copy");

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

function CopyWindow({ message, onTextChange }: { message: any; onTextChange: (text: string) => void }) {
    const settings = readSettings();
    const [count, setCount] = React.useState(String(settings.defaultMessageCount));
    const [direction, setDirection] = React.useState<CopyDirection>("up");
    const [text, setText] = React.useState("");
    const [loading, setLoading] = React.useState(false);

    const updateText = (value: string) => {
        setText(value);
        onTextChange(value);
    };

    const load = async () => {
        setLoading(true);
        try {
            const channelId = message.channel_id ?? message.channelId;
            const messages = await fetchConversation(channelId, message, direction, clampMessageCount(count));
            updateText(formatConversation(messages, channelId));
        } catch (error) {
            console.error("[BetterChatCopy] fetch failed", error);
            showToast("BetterChatCopy: failed to load messages");
        } finally {
            setLoading(false);
        }
    };

    return (
        <ReactNative.View style={{ alignSelf: "stretch", width: "100%", gap: 10 }}>
            <Forms.FormSection title="Messages">
                <ReactNative.TextInput
                    value={count}
                    onChangeText={setCount}
                    keyboardType="number-pad"
                    placeholder="100"
                    placeholderTextColor={TEXT_MUTED}
                    style={{ minHeight: 44, paddingHorizontal: 12, borderRadius: 8, color: TEXT_NORMAL }}
                />
            </Forms.FormSection>

            <Forms.FormSection title="Direction">
                <Forms.FormRow
                    label="Up from selected message"
                    subLabel={direction === "up" ? "Selected" : undefined}
                    onPress={() => setDirection("up")}
                />
                <Forms.FormRow
                    label="Down from selected message"
                    subLabel={direction === "down" ? "Selected" : undefined}
                    onPress={() => setDirection("down")}
                />
            </Forms.FormSection>

            <Forms.FormRow
                label={loading ? "Loading…" : "Load messages"}
                subLabel={`Up to ${MAX_MESSAGES} messages`}
                onPress={loading ? undefined : load}
            />

            <ReactNative.TextInput
                value={text}
                onChangeText={updateText}
                multiline
                textAlignVertical="top"
                placeholder="Load messages to preview and edit the copied text."
                placeholderTextColor={TEXT_MUTED}
                style={{ minHeight: 260, maxHeight: 420, padding: 12, borderRadius: 8, color: TEXT_NORMAL }}
            />
        </ReactNative.View>
    );
}

function openCopyWindow(message: any) {
    let currentText = "";

    ActionSheet?.hideActionSheet?.();
    showConfirmationAlert({
        title: "Copy Nearby Messages",
        content: <CopyWindow message={message} onTextChange={(text) => { currentText = text; }} />,
        confirmText: "Copy",
        cancelText: "Close",
        onConfirm: () => copyText(currentText),
        isDismissable: true,
    });
}

async function quickCopy(message: any, direction: CopyDirection) {
    const settings = readSettings();
    const channelId = message.channel_id ?? message.channelId;

    ActionSheet?.hideActionSheet?.();
    showToast(`Loading ${settings.defaultMessageCount} messages…`);

    try {
        const messages = await fetchConversation(channelId, message, direction, settings.defaultMessageCount);
        copyText(formatConversation(messages, channelId));
    } catch (error) {
        console.error("[BetterChatCopy] quick copy failed", error);
        showToast("BetterChatCopy: failed to load messages");
    }
}

function findCopyTextRow(row: any): boolean {
    const label = row?.props?.label?.toLowerCase?.();
    return label === "copy text" || label === "copy message text";
}

function patchMessageActionSheet() {
    if (!ActionSheet?.openLazy) return;

    unpatches.push(
        before("openLazy", ActionSheet, ([component, args, actionMessage]) => {
            const message = actionMessage?.message;
            const channelId = message?.channel_id ?? message?.channelId;
            if (args !== "MessageLongPressActionSheet" || !message?.id || !channelId) return;

            component
                .then((instance: any) => {
                    let unpatch: (() => void) | undefined;
                    unpatch = after("default", instance, (_, comp) => {
                        try {
                            React.useEffect(() => () => unpatch?.(), []);

                            const rows = findInReactTree(comp, (node) => node?.find?.(findCopyTextRow));
                            if (!rows) return comp;
                            if (rows.some((row: any) => row?.props?.betterChatCopyMarker)) return comp;

                            const position = Math.max(rows.findIndex(findCopyTextRow) + 1, 0);
                            const count = readSettings().defaultMessageCount;

                            const root = createActionSheetRow(
                                "Copy Nearby Messages",
                                `Copy up/down from this message (default ${count})`,
                                () => openCopyWindow(message),
                            );
                            root.props.betterChatCopyMarker = true;

                            rows.splice(
                                position,
                                0,
                                root,
                                createActionSheetRow(`Copy Up ${count}`, "Includes selected message", () => void quickCopy(message, "up")),
                                createActionSheetRow(`Copy Down ${count}`, "Includes selected message", () => void quickCopy(message, "down")),
                            );

                            return comp;
                        } catch (error) {
                            console.error("[BetterChatCopy] action sheet render failed", error);
                            return comp;
                        }
                    });
                })
                .catch((error: unknown) => {
                    console.error("[BetterChatCopy] action sheet load failed", error);
                });
        }),
    );
}

function SettingsScreen() {
    const [settings, setSettings] = React.useState(readSettings);

    const update = (patch: Partial<Settings>) => {
        const next = { ...settings, ...patch };
        next.defaultMessageCount = clampCount(next.defaultMessageCount);
        persistSettings(next);
        setSettings(next);
    };

    return (
        <ReactNative.ScrollView>
            <Forms.FormSection title="BetterChatCopy">
                <Forms.FormRow
                    label="Default message count"
                    subLabel={`${settings.defaultMessageCount} messages (1–${MAX_MESSAGES})`}
                />
                <ReactNative.TextInput
                    value={String(settings.defaultMessageCount)}
                    onChangeText={(value) => update({ defaultMessageCount: clampCount(value) })}
                    keyboardType="number-pad"
                    placeholderTextColor={TEXT_MUTED}
                    style={{ minHeight: 44, marginHorizontal: 16, paddingHorizontal: 12, borderRadius: 8, color: TEXT_NORMAL }}
                />
                <Forms.FormSwitchRow
                    label="Include timestamps"
                    value={settings.includeTimestamps}
                    onValueChange={(value) => update({ includeTimestamps: value })}
                />
                <Forms.FormSwitchRow
                    label="Include attachments"
                    subLabel="Adds attachment URLs to copied conversation text"
                    value={settings.includeAttachments}
                    onValueChange={(value) => update({ includeAttachments: value })}
                />
            </Forms.FormSection>
        </ReactNative.ScrollView>
    );
}

export default {
    onLoad() {
        persistSettings(readSettings());
        patchMessageActionSheet();
    },
    onUnload() {
        while (unpatches.length) {
            try {
                unpatches.pop()?.();
            } catch {}
        }
    },
    settings: SettingsScreen,
};
