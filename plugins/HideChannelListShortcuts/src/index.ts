import { findByProps } from "@vendetta/metro";
import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import settings from "./settings";

const unpatches: Array<() => void> = [];

const GUILD_BOOSTS_ROW = "guild-boosts";
const GUILD_SCHEDULED_EVENTS_ROW = "guild-scheduled-events";

function shouldHideGuildActionRow(row: any): boolean {
    if (storage.hideServerBoosts && row === GUILD_BOOSTS_ROW) return true;
    if (storage.hideEvents && row === GUILD_SCHEDULED_EVENTS_ROW) return true;
    return false;
}

function filterGuildActionRows(rows: any): any[] | undefined {
    if (!Array.isArray(rows)) return undefined;
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
        const visibleRows = filterGuildActionRows(rows);
        if (!visibleRows) return undefined;

        // Discord intentionally omits this divider when Scheduled Events is
        // the only guild-action row. Preserve that after hiding Boosts.
        if (visibleRows.length === 0) return false;
        if (visibleRows.length === 1 && visibleRows[0] === GUILD_SCHEDULED_EVENTS_ROW) {
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

    const isHiddenItem = (item: any) =>
        item?.section === guildActionsSection &&
        shouldHideGuildActionRow(getGuildActionRow(item.guildChannels, item.row));

    // Hide the shortcut at the channel-list renderer itself. This avoids
    // globally patching React/jsx and prevents GuildPowerupsChannelRow from
    // executing at all for a hidden Boosts row.
    if (typeof renderer.renderChannelListItem === "function") {
        safeRegisterPatch(() =>
            instead("renderChannelListItem", renderer, (args, orig) => {
                const [item] = args as [any];
                if (isHiddenItem(item)) return null;
                return orig(...args);
            })
        );
    }

    if (typeof renderer.getChannelListItemSize === "function") {
        safeRegisterPatch(() =>
            instead("getChannelListItemSize", renderer, (args, orig) => {
                const [item] = args as [any];
                if (isHiddenItem(item)) return 0;
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
