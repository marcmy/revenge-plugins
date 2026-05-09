import { findByProps } from "@vendetta/metro";
import { React } from "@vendetta/metro/common";
import { instead } from "@vendetta/patcher";
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

const emptyRow = () => React.createElement(React.Fragment, null);

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

function safeRegisterPatch(register: () => (() => void) | void) {
    try {
        const unpatch = register();
        if (typeof unpatch === "function") unpatches.push(unpatch);
    } catch { }
}

function patchJsxRuntime() {
    const jsxRuntime = findByProps("jsx", "jsxs");
    if (!jsxRuntime) return;

    for (const method of ["jsx", "jsxs"] as const) {
        if (typeof jsxRuntime[method] !== "function") continue;

        safeRegisterPatch(() =>
            instead(method, jsxRuntime, (args, orig) => {
                const [type] = args as [any, ...any[]];
                if (shouldHideType(type)) return emptyRow();
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
            if (shouldHideType(type)) return emptyRow();
            return orig(...args);
        })
    );
}

export default {
    onLoad() {
        storage.hideServerBoosts ??= true;
        storage.hideEvents ??= false;

        patchJsxRuntime();
        patchCreateElement();
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
