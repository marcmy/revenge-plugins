import { findByProps, findByStoreName } from "@vendetta/metro";
import { React, ReactNative } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
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
const FETCH_BATCH_SIZE = 100;
const FETCH_SETTLE_ATTEMPTS = 20;
const FETCH_SETTLE_DELAY_MS = 100;
const TEXT_NORMAL = (semanticColors as any).TEXT_NORMAL ?? "#dbdee1";
const TEXT_MUTED = (semanticColors as any).TEXT_MUTED ?? (semanticColors as any).TEXT_LOW_CONTRAST ?? "#949ba4";
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

function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function readSettings(): Settings {
    const raw = storage.settings ?? {};
    const count = Number(raw.defaultMessageCount);

    return {
        defaultMessageCount: Number.isFinite(count)
            ? Math.max(1, Math.min(MAX_MESSAGES, Math.round(count)))
            : DEFAULT_SETTINGS.defaultMessageCount,
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
        return Number.isFinite(numeric)
            ? Math.floor(numeric / 4_194_304) + 1_420_070_400_000
            : 0;
    }
}

function compareSnowflakes(a?: string, b?: string): number {
    if (!a || !b) return 0;

    try {
        const aa = BigInt(a);
        const bb = BigInt(b);
        return aa < bb ? -1 : aa > bb ? 1 : 0;
    } catch {
        return snowflakeTimestamp(a) - snowflakeTimestamp(b);
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

function compareMessagesChronologically(a: any, b: any): number {
    const timestampDelta = messageTimestampMs(a) - messageTimestampMs(b);
    if (timestampDelta !== 0) return timestampDelta;
    return compareSnowflakes(a?.id, b?.id);
}

function sortMessages(messages: any[]): any[] {
    return [...messages].sort(compareMessagesChronologically);
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

    return (
        member?.nick ??
        user?.globalName ??
        user?.global_name ??
        user?.username ??
        author?.globalName ??
        author?.global_name ??
        author?.username ??
        "Unknown"
    );
}

function getTimestampLabel(message: any): string {
    const ms = messageTimestampMs(message);
    if (!ms) return "";

    try {
        return new Date(ms).toLocaleString(undefined, {
            hour: "numeric",
            minute: "2-digit",
        });
    } catch {
        return "";
    }
}

function formatMentions(content: string, channelId: string): string {
    const guildId = ChannelStore?.getChannel?.(channelId)?.guild_id;

    return String(content ?? "")
        .replace(/<@!?(\d+)>/g, (_match, id) => {
            const user = UserStore?.getUser?.(id);
            return user
                ? `@${user.globalName ?? user.global_name ?? user.username}`
                : `@${id}`;
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

function getMessageCollection(channelId: string): any {
    try {
        return MessageStore?.getMessages?.(channelId);
    } catch {
        return undefined;
    }
}

function getMessagesArray(channelId: string): any[] {
    const messages = getMessageCollection(channelId);

    try {
        const array = messages?.toArray?.() ?? messages?._array ?? messages;
        return Array.isArray(array) ? array : [];
    } catch {
        return [];
    }
}

function looksLikeMessage(value: any): boolean {
    return (
        !!value &&
        typeof value === "object" &&
        typeof value.id === "string" &&
        (typeof value.content === "string" || value.author)
    );
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

function getStoreBatch(
    channelId: string,
    cursor: string,
    direction: CopyDirection,
    limit: number,
): any[] {
    const relevant = getMessagesArray(channelId).filter((message) => {
        const cmp = compareSnowflakes(message?.id, cursor);
        return direction === "up" ? cmp < 0 : cmp > 0;
    });

    return dedupeMessages(relevant)
        .sort((a, b) =>
            direction === "up"
                ? compareSnowflakes(b?.id, a?.id)
                : compareSnowflakes(a?.id, b?.id),
        )
        .slice(0, limit);
}

async function waitForStoreBatch(
    channelId: string,
    cursor: string,
    direction: CopyDirection,
    limit: number,
    previousIds: Set<string>,
): Promise<any[]> {
    let latest = getStoreBatch(channelId, cursor, direction, limit);

    for (let attempt = 0; attempt < FETCH_SETTLE_ATTEMPTS; attempt++) {
        const hasNewMessage = latest.some(
            (message) => message?.id && !previousIds.has(message.id),
        );
        const collection = getMessageCollection(channelId);

        if (hasNewMessage) return latest;
        if (!collection?.loadingMore && attempt >= 4) return latest;

        await delay(FETCH_SETTLE_DELAY_MS);
        latest = getStoreBatch(channelId, cursor, direction, limit);
    }

    return latest;
}

async function fetchBatch(
    channelId: string,
    cursor: string,
    direction: CopyDirection,
    limit: number,
): Promise<any[]> {
    if (!MessageActions?.fetchMessages) {
        throw new Error("Discord fetchMessages module is unavailable");
    }

    const cached = getStoreBatch(channelId, cursor, direction, limit);
    if (cached.length >= limit) return cached;

    const previousIds = new Set(
        getMessagesArray(channelId)
            .map((message) => message?.id)
            .filter(Boolean),
    );

    const args: any = { channelId, limit };
    args[direction === "up" ? "before" : "after"] = cursor;

    const result = MessageActions.fetchMessages(args);
    if (result && typeof result.then === "function") {
        await result;
    }

    const direct = extractMessages(result);
    if (direct.length) {
        return dedupeMessages([...cached, ...direct])
            .filter((message) => {
                const cmp = compareSnowflakes(message?.id, cursor);
                return direction === "up" ? cmp < 0 : cmp > 0;
            })
            .sort((a, b) =>
                direction === "up"
                    ? compareSnowflakes(b?.id, a?.id)
                    : compareSnowflakes(a?.id, b?.id),
            )
            .slice(0, limit);
    }

    return waitForStoreBatch(
        channelId,
        cursor,
        direction,
        limit,
        previousIds,
    );
}

function getEdgeCursor(messages: any[], direction: CopyDirection): string | undefined {
    if (!messages.length) return undefined;

    let edge = messages[0];

    for (const message of messages.slice(1)) {
        const cmp = compareSnowflakes(message?.id, edge?.id);

        if (
            (direction === "up" && cmp < 0) ||
            (direction === "down" && cmp > 0)
        ) {
            edge = message;
        }
    }

    return edge?.id;
}

async function fetchConversation(
    channelId: string,
    anchorMessage: any,
    direction: CopyDirection,
    count: number,
): Promise<any[]> {
    const wanted = clampCount(count);
    const collected = [anchorMessage];
    let cursor = anchorMessage.id;

    while (collected.length < wanted) {
        const limit = Math.min(FETCH_BATCH_SIZE, wanted - collected.length);
        const batch = await fetchBatch(channelId, cursor, direction, limit);
        if (!batch.length) break;

        const knownIds = new Set(collected.map((message) => message?.id).filter(Boolean));
        const filtered = batch.filter(
            (message) => message?.id && !knownIds.has(message.id),
        );

        if (!filtered.length) break;

        collected.push(...filtered);

        const nextCursor = getEdgeCursor(filtered, direction);
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;

        if (batch.length < limit) break;
    }

    const result = dedupeMessages(collected);
    return direction === "up"
        ? result.slice(-wanted)
        : result.slice(0, wanted);
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

function createActionSheetRow(
    label: string,
    subLabel: string,
    onPress: () => void,
) {
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

function CopyWindow({ message }: { message: any }) {
    const settings = readSettings();
    const [count, setCount] = React.useState(String(settings.defaultMessageCount));
    const [direction, setDirection] = React.useState<CopyDirection>("up");
    const [text, setText] = React.useState("");
    const [loading, setLoading] = React.useState(false);

    const load = async () => {
        if (loading) return;

        setLoading(true);

        try {
            const channelId = message.channel_id ?? message.channelId;
            const messages = await fetchConversation(
                channelId,
                message,
                direction,
                clampCount(count),
            );
            setText(formatConversation(messages, channelId));
        } catch (error) {
            console.error("[BetterChatCopy] fetch failed", error);
            showToast("BetterChatCopy: failed to load messages");
        } finally {
            setLoading(false);
        }
    };

    const copy = () => {
        if (loading) {
            showToast("BetterChatCopy: wait for loading to finish");
            return;
        }

        if (!text.trim()) {
            showToast("BetterChatCopy: load messages first");
            return;
        }

        copyText(text);
    };

    return (
        <ReactNative.View
            style={{ alignSelf: "stretch", width: "100%", gap: 10 }}
        >
            <Forms.FormSection title="Messages">
                <ReactNative.TextInput
                    value={count}
                    onChangeText={setCount}
                    keyboardType="number-pad"
                    placeholder="100"
                    placeholderTextColor={TEXT_MUTED}
                    style={{
                        minHeight: 44,
                        paddingHorizontal: 12,
                        borderRadius: 8,
                        color: TEXT_NORMAL,
                    }}
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

            <Forms.FormRow
                label="Copy"
                subLabel={
                    loading
                        ? "Wait for loading to finish"
                        : text
                          ? "Copy the current edited transcript"
                          : "Load messages first"
                }
                onPress={!loading && text ? copy : undefined}
            />

            <ReactNative.TextInput
                value={text}
                onChangeText={setText}
                multiline
                textAlignVertical="top"
                placeholder="Load messages to preview and edit the copied text."
                placeholderTextColor={TEXT_MUTED}
                style={{
                    minHeight: 260,
                    maxHeight: 420,
                    padding: 12,
                    borderRadius: 8,
                    color: TEXT_NORMAL,
                }}
            />
        </ReactNative.View>
    );
}

function openCopyWindow(message: any) {
    ActionSheet?.hideActionSheet?.();

    showConfirmationAlert({
        title: "Copy Nearby Messages",
        content: <CopyWindow message={message} />,
        confirmText: "Close",
        onConfirm: () => {},
        isDismissable: true,
    });
}

async function quickCopy(message: any, direction: CopyDirection) {
    const settings = readSettings();
    const channelId = message.channel_id ?? message.channelId;

    ActionSheet?.hideActionSheet?.();
    showToast(`Loading ${settings.defaultMessageCount} messages…`);

    try {
        const messages = await fetchConversation(
            channelId,
            message,
            direction,
            settings.defaultMessageCount,
        );
        copyText(formatConversation(messages, channelId));
    } catch (error) {
        console.error("[BetterChatCopy] quick copy failed", error);
        showToast("BetterChatCopy: failed to load messages");
    }
}

function isActionSheetRowLike(row: any): boolean {
    const props = row?.props;
    if (!props) return false;

    const ActionSheetRow = actionSheetComponents?.ActionSheetRow;
    if (ActionSheetRow && row?.type === ActionSheetRow) return true;

    return (
        typeof props.label === "string" &&
        typeof props.onPress === "function"
    );
}

function findActionRows(comp: any): any[] | undefined {
    const rows = findInReactTree(
        comp,
        (node) =>
            Array.isArray(node) &&
            node.some((row: any) => isActionSheetRowLike(row)),
    );

    return Array.isArray(rows) ? rows : undefined;
}

function patchMessageActionSheet() {
    if (!ActionSheet?.openLazy) return;

    unpatches.push(
        before("openLazy", ActionSheet, ([component, args, actionMessage]) => {
            const message = actionMessage?.message;
            const channelId = message?.channel_id ?? message?.channelId;

            if (
                args !== "MessageLongPressActionSheet" ||
                !message?.id ||
                !channelId
            ) {
                return;
            }

            component
                .then((instance: any) => {
                    let unpatch: (() => void) | undefined;

                    unpatch = after("default", instance, (_, comp) => {
                        try {
                            React.useEffect(() => () => unpatch?.(), []);

                            const rows = findActionRows(comp);
                            if (!rows) return comp;

                            if (
                                rows.some(
                                    (row: any) =>
                                        row?.props?.betterChatCopyMarker,
                                )
                            ) {
                                return comp;
                            }

                            const count = readSettings().defaultMessageCount;
                            const root = createActionSheetRow(
                                "Copy Nearby Messages",
                                `Copy up/down from this message (default ${count})`,
                                () => openCopyWindow(message),
                            );
                            root.props.betterChatCopyMarker = true;

                            let position = rows.length;
                            for (let index = rows.length - 1; index >= 0; index--) {
                                if (isActionSheetRowLike(rows[index])) {
                                    position = index + 1;
                                    break;
                                }
                            }

                            rows.splice(
                                position,
                                0,
                                root,
                                createActionSheetRow(
                                    `Copy Up ${count}`,
                                    "Includes selected message",
                                    () => void quickCopy(message, "up"),
                                ),
                                createActionSheetRow(
                                    `Copy Down ${count}`,
                                    "Includes selected message",
                                    () => void quickCopy(message, "down"),
                                ),
                            );

                            return comp;
                        } catch (error) {
                            console.error(
                                "[BetterChatCopy] action sheet render failed",
                                error,
                            );
                            return comp;
                        }
                    });
                })
                .catch((error: unknown) => {
                    console.error(
                        "[BetterChatCopy] action sheet load failed",
                        error,
                    );
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
                    onChangeText={(value) =>
                        update({ defaultMessageCount: clampCount(value) })
                    }
                    keyboardType="number-pad"
                    placeholderTextColor={TEXT_MUTED}
                    style={{
                        minHeight: 44,
                        marginHorizontal: 16,
                        paddingHorizontal: 12,
                        borderRadius: 8,
                        color: TEXT_NORMAL,
                    }}
                />
                <Forms.FormSwitchRow
                    label="Include timestamps"
                    value={settings.includeTimestamps}
                    onValueChange={(value) =>
                        update({ includeTimestamps: value })
                    }
                />
                <Forms.FormSwitchRow
                    label="Include attachments"
                    subLabel="Adds attachment URLs to copied conversation text"
                    value={settings.includeAttachments}
                    onValueChange={(value) =>
                        update({ includeAttachments: value })
                    }
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
