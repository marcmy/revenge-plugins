import { findAll } from "@vendetta/metro";
import { React } from "@vendetta/metro/common";
import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import settings from "./settings";

const unpatches: Array<() => void> = [];
const patchedFunctions = new WeakSet<Function>();

let retryTimer: ReturnType<typeof setInterval> | undefined;

const BOOST_NAME_TOKENS = ["guildpowerupschannelrow", "serverboost", "powerup", "boost"];
const EVENTS_NAME_TOKENS = ["guildeventschannelrow", "eventschannelrow", "guildevents", "event"];

const BOOST_SOURCE_TOKENS = ["SERVER_BOOSTS", "premium/subscriptions", "premium-subscriptions", "server-boost"];
const EVENTS_SOURCE_TOKENS = ["GUILD_EVENTS", "guild-events", "/events"];

const normalize = (s: string) => s.toLowerCase();

const emptyRow = () => React.createElement(React.Fragment, null);

function methodLooksLike(name: string, fn: Function, nameTokens: string[], sourceTokens: string[]): boolean {
    const normalizedName = normalize(name || "");
    if (nameTokens.some((token) => normalizedName.includes(token))) return true;

    const fnName = normalize(fn.displayName || fn.name || "");
    if (nameTokens.some((token) => fnName.includes(token))) return true;

    try {
        const src = String(fn);
        if (sourceTokens.some((token) => src.includes(token))) return true;
    } catch { }

    return false;
}

function patchMethod(moduleObj: Record<string, any>, methodName: string) {
    const fn = moduleObj?.[methodName];
    if (typeof fn !== "function") return;
    if (patchedFunctions.has(fn)) return;

    const isBoosts = methodLooksLike(methodName, fn, BOOST_NAME_TOKENS, BOOST_SOURCE_TOKENS);
    const isEvents = methodLooksLike(methodName, fn, EVENTS_NAME_TOKENS, EVENTS_SOURCE_TOKENS);
    if (!isBoosts && !isEvents) return;

    patchedFunctions.add(fn);
    unpatches.push(
        instead(methodName, moduleObj, (args, orig) => {
            if (isBoosts && storage.hideServerBoosts) return emptyRow();
            if (isEvents && storage.hideEvents) return emptyRow();
            return orig(...args);
        })
    );
}

function patchShortcutRows() {
    const modules = findAll((m) => m && typeof m === "object") as Record<string, any>[];

    for (const moduleObj of modules) {
        for (const key of Object.keys(moduleObj)) {
            patchMethod(moduleObj, key);
        }
    }
}

function startRetryPatch() {
    retryTimer = setInterval(() => {
        try {
            patchShortcutRows();
        } catch { }
    }, 3000);
}

function stopRetryPatch() {
    if (!retryTimer) return;
    clearInterval(retryTimer);
    retryTimer = undefined;
}

export default {
    onLoad() {
        storage.hideServerBoosts ??= true;
        storage.hideEvents ??= false;

        patchShortcutRows();
        startRetryPatch();
    },
    onUnload() {
        stopRetryPatch();

        while (unpatches.length) {
            try {
                unpatches.pop()?.();
            } catch { }
        }
    },
    settings,
};
