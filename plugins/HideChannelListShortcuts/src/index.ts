import { findAll, findByProps } from "@vendetta/metro";
import { React, i18n } from "@vendetta/metro/common";
import { after, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import settings from "./settings";

const unpatches: Array<() => void> = [];

const STRING_KEYS = [
    "title",
    "label",
    "name",
    "text",
    "accessibilityLabel",
    "contentDescription",
    "route",
    "path",
    "url",
    "href",
    "id",
    "key",
    "testID",
    "type",
] as const;

const WALK_KEYS = [
    "children",
    "items",
    "sections",
    "data",
    "rows",
    "entries",
    "trailingItems",
    "leadingItems",
    "header",
    "footer",
] as const;

const STRONG_SOURCE_TOKENS = [
    "SERVER_BOOSTS",
    "premium/subscriptions",
    "server-boost",
    "guild-events",
];

const FALLBACK_SOURCE_TOKENS = [
    "ChannelList",
    "channel list",
    "GuildChannel",
    "/channels/",
];

type StringMatcher = (text: string) => boolean;
const PRESS_HANDLER_KEYS = ["onPress", "onLongPress", "onPressIn"] as const;

const BOOST_PRESS_TOKENS = [
    "premium/subscriptions",
    "premium-subscriptions",
    "server-boost",
    "guildboost",
];

const EVENTS_PRESS_TOKENS = [
    "/events",
    "guild-events",
    "guildevents",
];

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

const isServerBoostText = (text: string) => {
    const value = normalize(text);
    if (!value) return false;

    const translated = typeof i18n?.Messages?.SERVER_BOOSTS === "string"
        ? normalize(i18n.Messages.SERVER_BOOSTS)
        : null;

    return value === translated
        || value.startsWith(`${translated ?? "server boosts"} `)
        || value === "server boosts"
        || value.startsWith("server boosts ")
        || value.includes("premium/subscriptions")
        || value.includes("server-boost")
        || value.includes("guildboost");
};

const isEventsText = (text: string) => {
    const value = normalize(text);
    if (!value) return false;

    const translated = [
        i18n?.Messages?.EVENTS,
        i18n?.Messages?.GUILD_EVENTS,
        i18n?.Messages?.GUILD_EVENT_UPSELL_TITLE,
    ]
        .filter((v): v is string => typeof v === "string")
        .map(normalize);

    return translated.includes(value)
        || value === "events"
        || value.startsWith("events ")
        || value.includes("/events")
        || value.includes("guild-events");
};

function collectStringsDeep(value: any, out: string[] = [], depth = 0): string[] {
    if (value == null || depth > 5) return out;
    if (typeof value === "string") {
        out.push(value);
        return out;
    }

    if (Array.isArray(value)) {
        for (const item of value) collectStringsDeep(item, out, depth + 1);
        return out;
    }

    if (typeof value === "object") {
        for (const key of STRING_KEYS) {
            const raw = value[key];
            if (typeof raw === "string") out.push(raw);
        }

        if ("children" in value) collectStringsDeep(value.children, out, depth + 1);
        if ("props" in value) collectStringsDeep(value.props, out, depth + 1);
    }

    return out;
}

function matchesAnyText(props: any, matcher: StringMatcher): boolean {
    const values = collectStringsDeep(props);
    return values.some((v) => matcher(v));
}

function hasPressSourceToken(props: any, tokens: string[]): boolean {
    for (const key of PRESS_HANDLER_KEYS) {
        const handler = props?.[key];
        if (typeof handler !== "function") continue;

        try {
            const src = String(handler).toLowerCase();
            if (tokens.some((token) => src.includes(token.toLowerCase()))) return true;
        } catch { }
    }

    return false;
}

function isPressableLike(type: any, props: any): boolean {
    if (!props || typeof props !== "object") return false;
    if (typeof props.onPress === "function") return true;
    if (typeof props.onLongPress === "function") return true;
    if (typeof props.onPressIn === "function") return true;

    const typeName = String(
        typeof type === "string"
            ? type
            : (type?.displayName ?? type?.name ?? "")
    ).toLowerCase();

    return typeName.includes("pressable")
        || typeName.includes("touchable")
        || typeName.includes("row")
        || typeName.includes("cell");
}

function collectNodeStrings(node: any): string[] {
    const values: string[] = [];

    const collectFrom = (obj: any) => {
        if (!obj || typeof obj !== "object") return;

        for (const key of STRING_KEYS) {
            const raw = obj[key];
            if (typeof raw === "string") values.push(raw);
        }

        if (typeof obj.children === "string") values.push(obj.children);
    };

    collectFrom(node);
    collectFrom(node?.props);
    collectFrom(node?.item);

    return values;
}

function shouldHideNode(node: any): boolean {
    if (!storage.hideServerBoosts && !storage.hideEvents) return false;
    if (!node || typeof node !== "object") return false;

    const values = collectNodeStrings(node);
    if (!values.length) return false;

    const matchesBoost = storage.hideServerBoosts && values.some(isServerBoostText);
    const matchesEvents = storage.hideEvents && values.some(isEventsText);

    return matchesBoost || matchesEvents;
}

function pruneTree(node: any, seen: WeakSet<object> = new WeakSet()): any {
    if (node == null) return node;

    if (Array.isArray(node)) {
        const next = node
            .map(child => pruneTree(child, seen))
            .filter(child => child != null);
        node.length = 0;
        node.push(...next);
        return node;
    }

    if (typeof node !== "object") return node;
    if (seen.has(node)) return node;
    seen.add(node);

    if (shouldHideNode(node)) return null;

    for (const key of WALK_KEYS) {
        if (!(key in node)) continue;
        const value = node[key];
        const pruned = pruneTree(value, seen);
        if (pruned == null) {
            if (Array.isArray(value)) node[key] = [];
            else delete node[key];
        } else {
            node[key] = pruned;
        }
    }

    if (node.props && typeof node.props === "object" && "children" in node.props) {
        const prunedChildren = pruneTree(node.props.children, seen);
        if (prunedChildren == null) delete node.props.children;
        else node.props.children = prunedChildren;
    }

    return node;
}

function hasSourceToken(fn: Function, tokens: string[]): boolean {
    let src = "";
    try {
        src = String(fn);
    } catch {
        return false;
    }

    return tokens.some(token => src.includes(token));
}

function patchTargets() {
    const seen = new Set<any>();

    const strongTargets = findAll((m) =>
        m && typeof m === "object"
        && typeof m.default === "function"
        && hasSourceToken(m.default, STRONG_SOURCE_TOKENS)
    );

    const targets = strongTargets.length
        ? strongTargets
        : findAll((m) =>
            m && typeof m === "object"
            && typeof m.default === "function"
            && hasSourceToken(m.default, FALLBACK_SOURCE_TOKENS)
        ).slice(0, 40);

    for (const target of targets) {
        if (seen.has(target)) continue;
        seen.add(target);

        try {
            unpatches.push(after("default", target, (_, ret) => pruneTree(ret)));
        } catch { }
    }
}

function patchCreateElementFallback() {
    if (!React?.createElement) return;

    unpatches.push(instead("createElement", React, (args, orig) => {
        const [type, props, ...children] = args as [any, any, ...any[]];

        if (!props || !isPressableLike(type, props)) {
            return orig(...args);
        }

        const combined = children.length ? { ...props, children } : props;

        const hideBoosts = storage.hideServerBoosts && (
            matchesAnyText(combined, isServerBoostText)
            || hasPressSourceToken(props, BOOST_PRESS_TOKENS)
        );
        const hideEvents = storage.hideEvents && (
            matchesAnyText(combined, isEventsText)
            || hasPressSourceToken(props, EVENTS_PRESS_TOKENS)
        );

        if (hideBoosts || hideEvents) return null;
        return orig(...args);
    }));
}

function patchJsxRuntimeFallback() {
    const jsxRuntime = findByProps("jsx", "jsxs");
    if (!jsxRuntime) return;

    for (const method of ["jsx", "jsxs"] as const) {
        if (typeof jsxRuntime[method] !== "function") continue;

        unpatches.push(instead(method, jsxRuntime, (args, orig) => {
            const [type, props] = args as [any, any, ...any[]];
            if (!props || !isPressableLike(type, props)) return orig(...args);

            const hideBoosts = storage.hideServerBoosts && (
                matchesAnyText(props, isServerBoostText)
                || hasPressSourceToken(props, BOOST_PRESS_TOKENS)
            );
            const hideEvents = storage.hideEvents && (
                matchesAnyText(props, isEventsText)
                || hasPressSourceToken(props, EVENTS_PRESS_TOKENS)
            );

            if (hideBoosts || hideEvents) return null;
            return orig(...args);
        }));
    }
}

export default {
    onLoad() {
        storage.hideServerBoosts ??= true;
        storage.hideEvents ??= false;
        patchTargets();
        patchCreateElementFallback();
        patchJsxRuntimeFallback();
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
