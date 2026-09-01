import { findByName, findByProps } from "@vendetta/metro";
import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import settings from "./settings";

const unpatches: Array<() => void> = [];

const GUILD_BOOSTS_ROW = "guild-boosts";
const GUILD_SCHEDULED_EVENTS_ROW = "guild-scheduled-events";

const BOOST_COMPONENT_NAMES = [
    "GuildPowerupsChannelRow",
    "PowerupsChannelRow",
];

const EVENTS_COMPONENT_NAMES = [
    "GuildEventsChannelRow",
    "GuildEventChannelRow",
    "EventsChannelRow",
];

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

        // Discord omits this divider when Scheduled Events is the only
        // guild-action row. Preserve that after hiding Boosts.
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

function patchNamedComponent(name: string, shouldHide: () => boolean) {
    try {
        // false returns the module object rather than only its default export,
        // allowing us to patch this one component without touching React/jsx.
        const module = findByName(name, false) as any;
        if (!module || typeof module.default !== "function") return false;

        safeRegisterPatch(() =>
            instead("default", module, (args, orig) => {
                if (shouldHide()) return null;
                return orig(...args);
            })
        );
        return true;
    } catch {
        return false;
    }
}

function patchShortcutComponents() {
    for (const name of BOOST_COMPONENT_NAMES) {
        if (patchNamedComponent(name, () => !!storage.hideServerBoosts)) break;
    }

    for (const name of EVENTS_COMPONENT_NAMES) {
        if (patchNamedComponent(name, () => !!storage.hideEvents)) break;
    }
}

function patchChannelListLayout() {
    const channelListState = findByProps(
        "SECTION_INDEX_GUILD_ACTIONS",
        "SECTION_INDEX_CHANNEL_NOTICES"
    );

    // Do not require renderChannelListItem here. On some Discord/Revenge
    // builds that export is not discoverable through findByProps, which made
    // the entire layout patch silently fail.
    const renderer = findByProps(
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

        patchShortcutComponents();
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
