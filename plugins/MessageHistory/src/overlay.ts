import { dedupeDeleteRecordsByMessage, getRecordMessageTimestamp } from "./history";
import type { HistoryRecord } from "./types";

export type MessageOrderKey = readonly [timestamp: number, messageId: string];

export interface LoadedMessageWindow {
    oldestKey: MessageOrderKey;
    newestKey: MessageOrderKey;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
}

interface RealMessageEntry {
    index: number;
    key: MessageOrderKey;
    message: any;
}

export function getRowMessage(row: any): any | null {
    const direct = row?.message ?? row?.messageRecord ?? row?.content?.message;
    if (direct?.message_history_overlay_deleted === true) return null;
    if (direct?.id) return direct;

    if (Array.isArray(row?.content)) {
        for (const child of row.content) {
            const nested = child?.message ?? child?.messageRecord;
            if (nested?.message_history_overlay_deleted === true) continue;
            if (nested?.id) return nested;
        }
    }

    return null;
}

export function getLoadedMessageWindow(
    rows: any[],
    hasMoreBefore: boolean,
    hasMoreAfter: boolean,
): LoadedMessageWindow | null {
    const entries = getRealMessageEntries(rows);
    if (!entries.length) return null;

    let oldestKey = entries[0].key;
    let newestKey = entries[0].key;
    for (const entry of entries.slice(1)) {
        if (compareOrderKeys(entry.key, oldestKey) < 0) oldestKey = entry.key;
        if (compareOrderKeys(entry.key, newestKey) > 0) newestKey = entry.key;
    }

    return { oldestKey, newestKey, hasMoreBefore, hasMoreAfter };
}

export function selectOverlayDeleteRecords(
    records: HistoryRecord[],
    window: LoadedMessageWindow,
): HistoryRecord[] {
    return dedupeDeleteRecordsByMessage(records)
        .filter((record) => record.inlineHidden !== true)
        .filter((record) => {
            const key = getRecordOrderKey(record);
            if (compareOrderKeys(key, window.oldestKey) < 0 && window.hasMoreBefore) return false;
            if (compareOrderKeys(key, window.newestKey) > 0 && window.hasMoreAfter) return false;
            return true;
        });
}

export function mergeDeletedRows(
    rows: any[],
    records: HistoryRecord[],
    makeRow: (record: HistoryRecord) => any,
    options: { hasMoreBefore: boolean; hasMoreAfter: boolean },
): any[] {
    if (!Array.isArray(rows) || !rows.length || !records.length) return Array.isArray(rows) ? [...rows] : rows;

    const realEntries = getRealMessageEntries(rows);
    const window = getLoadedMessageWindow(rows, options.hasMoreBefore, options.hasMoreAfter);
    if (!realEntries.length || !window) return [...rows];

    const existingIds = new Set(realEntries.map((entry) => String(entry.message.id)));
    const ascending = compareOrderKeys(realEntries[0].key, realEntries[realEntries.length - 1].key) <= 0;
    const candidates = selectOverlayDeleteRecords(records, window)
        .filter((record) => !existingIds.has(String(record.messageId)))
        .sort((a, b) => {
            const delta = compareOrderKeys(getRecordOrderKey(a), getRecordOrderKey(b));
            return ascending ? delta : -delta;
        });

    if (!candidates.length) return [...rows];

    const before = new Map<number, HistoryRecord[]>();
    const after = new Map<number, HistoryRecord[]>();
    const lastRealIndex = realEntries[realEntries.length - 1].index;

    for (const record of candidates) {
        const recordKey = getRecordOrderKey(record);
        const nextEntry = realEntries.find((entry) =>
            ascending ? compareOrderKeys(recordKey, entry.key) < 0 : compareOrderKeys(recordKey, entry.key) > 0,
        );

        if (nextEntry) {
            const bucket = before.get(nextEntry.index) ?? [];
            bucket.push(record);
            before.set(nextEntry.index, bucket);
        } else {
            const bucket = after.get(lastRealIndex) ?? [];
            bucket.push(record);
            after.set(lastRealIndex, bucket);
        }
    }

    const result: any[] = [];
    for (let index = 0; index < rows.length; index++) {
        for (const record of before.get(index) ?? []) {
            const overlayRow = safeMakeRow(record, makeRow);
            if (overlayRow) result.push(overlayRow);
        }

        result.push(rows[index]);

        for (const record of after.get(index) ?? []) {
            const overlayRow = safeMakeRow(record, makeRow);
            if (overlayRow) result.push(overlayRow);
        }
    }

    return result;
}

export function createRenderRefreshScheduler(callback: () => void, delayMs = 16) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    return {
        request() {
            if (disposed || timeout !== undefined) return;
            timeout = setTimeout(() => {
                timeout = undefined;
                if (!disposed) callback();
            }, Math.max(0, delayMs));
        },
        dispose() {
            disposed = true;
            if (timeout !== undefined) clearTimeout(timeout);
            timeout = undefined;
        },
    };
}

function getRealMessageEntries(rows: any[]): RealMessageEntry[] {
    const entries: RealMessageEntry[] = [];
    for (let index = 0; index < rows.length; index++) {
        const message = getRowMessage(rows[index]);
        if (!message?.id) continue;
        const timestamp = getMessageTimestamp(message);
        if (!timestamp) continue;
        entries.push({ index, key: [timestamp, String(message.id)], message });
    }
    return entries;
}

function getRecordOrderKey(record: HistoryRecord): MessageOrderKey {
    return [getRecordMessageTimestamp(record), String(record.messageId)];
}

function getMessageTimestamp(message: any): number | undefined {
    const value = message?.timestamp ?? message?.editedTimestamp ?? message?.edited_timestamp;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string") {
        const parsedDate = Date.parse(value);
        if (Number.isFinite(parsedDate)) return parsedDate;
        const parsedNumber = Number(value);
        if (Number.isFinite(parsedNumber)) return parsedNumber;
    }

    try {
        const primitive = value?.valueOf?.();
        if (typeof primitive === "number" && Number.isFinite(primitive)) return primitive;
    } catch {}

    return timestampFromSnowflake(String(message?.id ?? ""));
}

function compareOrderKeys(a: MessageOrderKey, b: MessageOrderKey): number {
    const timestampDelta = a[0] - b[0];
    if (timestampDelta) return timestampDelta;

    try {
        const aId = BigInt(a[1]);
        const bId = BigInt(b[1]);
        return aId < bId ? -1 : aId > bId ? 1 : 0;
    } catch {
        return a[1].localeCompare(b[1]);
    }
}

function timestampFromSnowflake(id: string): number | undefined {
    if (!/^\d+$/.test(id)) return undefined;
    try {
        const timestamp = Number((BigInt(id) >> 22n) + 1_420_070_400_000n);
        return Number.isFinite(timestamp) && timestamp > 1_420_070_400_000 ? timestamp : undefined;
    } catch {
        return undefined;
    }
}

function safeMakeRow(record: HistoryRecord, makeRow: (record: HistoryRecord) => any): any | null {
    try {
        return makeRow(record) ?? null;
    } catch (error) {
        console.error("[MessageHistory] failed to build deleted overlay row", error);
        return null;
    }
}
