import { findByProps } from "@vendetta/metro";
import { React } from "@vendetta/metro/common";
import { before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import settings from "./settings";

const unpatches: Array<() => void> = [];

const BOOST_COMPONENT_NAMES = [
    "GuildPowerupsChannelRow",
    "PowerupsChannelRow",
];

const EVENTS_COMPONENT_NAMES = [
    "GuildEventsChannelRow",
    "GuildEventChannelRow",
    "EventsChannelRow",
];

const GUILD_BOOSTS_ROW = "guild-boosts";
const GUILD_SCHEDULED_EVENTS_ROW = "guild-scheduled-events";

function getTypeName(type: any): string {
    return String(
        typeof type === "string"
            ? type
            : (type?.displayName ?? type?.name ?? "")
    );
}

function matchesComponentName(type: any, names: string[]): boolean {
    const typeName = getTypeName(type);
    if (!typeName) return false;
    return names.some((name) => typeName.includes(name));
}

function shouldHideType(type: any): boolean {
    if (storage.hideServerBoosts && matchesComponentName(type, BOOST_COMPONENT_NAMES)) return true;
    if (storage.hideEvents && matchesComponentName(type, EVENTS_COMPONENT_NAMES)) return true;
    return false;
}

function shouldHideGuildActionRow(row: any): boolean {
    if (storage.hideServerBoosts && row === GUILD_BOOSTS_ROW) return true;
    if (storage.hideEvents && row === GUILD_SCHEDULED_EVENTS_ROW) return true;
    return false;
}

function filterGuildActionRows(rows: any): any {
    if (!Array.isArray(rows)) return rows;
    return rows.filter((row) => !shouldHideGuildActionRow(row));
}

function getGuildActionRow(guildChannels: any, row: any): any {
    try {
        return guildChannels?.getGuildActionSection?.()?.getRow?.(row);
    } catch {
        return undefined;
    }
}

function shouldHaveGuildActionFooter(guildChannels: any): boolean | undefined {
    try {
        const rows = guildChannels?.getGuildActionSection?.()?.getRows?.();
        if (!Array.isArray(rows)) return undefined;

        const visibleRows = filterGuildActionRows(rows);
        if (!Array.isArray(visibleRows)) return undefined;

        // Discord intentionally omits the guild-actions footer divider when
        // Scheduled Events is the only action row. If Boosts is hidden from a
        // [Scheduled Events, Boosts] section, preserve that same behavior.
        if (visibleRows.length === 0) return false;
        if (
            visibleRows.length === 1 &&
            visibleRows[0] === GUILD_SCHEDULED_EVENTS_ROW
        ) {
            return false;
        }

        return true;
    } catch {
        return undefined;
    }
}

function safeRegisterPatch(register: () => (() => void) | void) {
    try {
        const unpatch = register();
        if (typeof unpatch === "function") unpatches.push(unpatch);
    } catch { }
}

function patchChannelListStore() {
    const channelListStore = findByProps(
        "getGuild",
        "getGuildWithoutChangingGuildActionRows",
        "recentsChannelCount"
    );
    if (!channelListStore || typeof channelListStore.getGuild !== "function") return;

    safeRegisterPatch(() =>
        before("getGuild", channelListStore, (args) => {
            const options = args?.[1];
            const rows = options?.guildActionRows;
            if (!Array.isArray(rows)) return;

            const filteredRows = filterGuildActionRows(rows);
            if (!Array.isArray(filteredRows) || filteredRows.length === rows.length) return;

            // Feed the filtered rows into ChannelListState so FastList never
            // allocates a row (or footer divider) for shortcuts we hide.
            args[1] = {
                ...options,
                guildActionRows: filteredRows,
            };
        })
    );
}

function patchJsxRuntime() {
    const jsxRuntime = findByProps("jsx", "jsxs");
    if (!jsxRuntime) return;

    for (const method of ["jsx", "jsxs"] as const) {
        if (typeof jsxRuntime[method] !== "function") continue;

        safeRegisterPatch(() =>
            instead(method, jsxRuntime, (args, orig) => {
                const [type] = args as [any, ...any[]];
                if (shouldHideType(type)) return null;
                return orig(...args);
            })
        );
    }
}

function patchCreateElement() {
    if (!React?.createElement) return;

    safeRegisterPatch(() =>
        instead("createElement", React, (args, orig) => {
            const [type] = args as [any, ...any[]];
            if (shouldHideType(type)) return null;
            return orig(...args);
        })
    );
}

function patchChannelListLayout() {
    const channelListState = findByProps(
        "SECTION_INDEX_GUILD_ACTIONS",
        "SECTION_INDEX_CHANNEL_NOTICES"
    );
    const renderer = findByProps(
        "renderChannelListItem",
        "getChannelListItemSize",
        "renderChannelListSectionFooter",
        "getChannelListSectionFooterSize"
    );

    if (!channelListState || !renderer) return;

    const guildActionsSection = channelListState.SECTION_INDEX_GUILD_ACTIONS;

    if (typeof renderer.getChannelListItemSize === "function") {
        safeRegisterPatch(() =>
            instead("getChannelListItemSize", renderer, (args, orig) => {
                const [item] = args as [any];
                if (
                    item?.section === guildActionsSection &&
                    shouldHideGuildActionRow(getGuildActionRow(item.guildChannels, item.row))
                ) {
                    return 0;
                }
                return orig(...args);
            })
        );
    }

    const shouldRemoveFooter = (guildChannels: any, section: any) =>
        section === guildActionsSection && shouldHaveGuildActionFooter(guildChannels) === false;

    if (typeof renderer.renderChannelListSectionFooter === "function") {
        safeRegisterPatch(() =>
            instead("renderChannelListSectionFooter", renderer, (args, orig) => {
                const [guildChannels, section] = args as [any, any, ...any[]];
                if (shouldRemoveFooter(guildChannels, section)) return null;
                return orig(...args);
            })
        );
    }

    if (typeof renderer.getChannelListSectionHasFooterDivider === "function") {
        safeRegisterPatch(() =>
            instead("getChannelListSectionHasFooterDivider", renderer, (args, orig) => {
                const [guildChannels, section] = args as [any, any, ...any[]];
                if (shouldRemoveFooter(guildChannels, section)) return false;
                return orig(...args);
            })
        );
    }

    if (typeof renderer.getChannelListSectionFooterSize === "function") {
        safeRegisterPatch(() =>
            instead("getChannelListSectionFooterSize", renderer, (args, orig) => {
                const [guildChannels, section] = args as [any, any, ...any[]];
                if (shouldRemoveFooter(guildChannels, section)) return 0;
                return orig(...args);
            })
        );
    }

    const footerHelpers = findByProps(
        "getSectionFooterConfig",
        "getSectionFooterActiveVoiceChannels"
    );

    if (footerHelpers && typeof footerHelpers.getSectionFooterConfig === "function") {
        safeRegisterPatch(() =>
            instead("getSectionFooterConfig", footerHelpers, (args, orig) => {
                const result = orig(...args);
                const [guildChannels, , section] = args as [any, any, any];
                if (!shouldRemoveFooter(guildChannels, section) || !result) return result;
                return { ...result, hasDivider: false };
            })
        );
    }
}

export default {
    onLoad() {
        storage.hideServerBoosts ??= true;
        storage.hideEvents ??= false;

        patchChannelListStore();
        patchJsxRuntime();
        patchCreateElement();
        patchChannelListLayout();
    },
    onUnload() {
        while (unpatches.length) {
            try {
                unpatches.pop()?.();
            } catch { }
        }
    },
    settings,
};
