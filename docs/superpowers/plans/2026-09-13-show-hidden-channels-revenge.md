# ShowHiddenChannels Revenge Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a maintainable Revenge/mobile port of ShowHiddenChannels that exposes inaccessible channels already present in the client model, routes them to a read-only information view, and prevents normal message/voice behavior from treating them as accessible.

**Architecture:** Implement a semantic mobile port split into a core hidden-channel classifier plus narrowly scoped patch adapters for the channel list, navigation, message fetching, unreads, and voice. Keep real permission semantics intact outside those adapters and fail closed when a Discord Metro module cannot be identified safely.

**Tech Stack:** TypeScript/TSX, Revenge/Vendetta plugin APIs, `@vendetta/metro`, `@vendetta/patcher`, `@vendetta/plugin`, React Native/Vendetta UI, Rollup/SWC build pipeline.

**Spec:** `docs/superpowers/specs/2026-09-13-show-hidden-channels-revenge-design.md`

## Global Constraints

- Do not bypass Discord's server-side private-channel metadata obfuscation or recover metadata Discord did not send to the client.
- Do not globally force `VIEW_CHANNEL` permission to true.
- Do not fetch messages from inaccessible channels.
- Do not join inaccessible voice/stage channels.
- Prefer narrow capability-based Metro discovery and independent failure of each patch.
- Do not patch React/JSX globally.
- Keep `index.ts` lifecycle-focused and split implementation by responsibility.

---

### Task 1: Scaffold plugin, settings, and core hidden-channel helpers

**Files:**
- Create: `plugins/ShowHiddenChannels/manifest.json`
- Create: `plugins/ShowHiddenChannels/src/index.ts`
- Create: `plugins/ShowHiddenChannels/src/settings.tsx`
- Create: `plugins/ShowHiddenChannels/src/core/hiddenChannel.ts`

**Interfaces:**
- Produces: `getChannel(channelOrId)`, `canViewChannel(channel)`, `isHiddenChannel(channelOrId)`, `isTextLikeChannel(channel)`, `isVoiceLikeChannel(channel)`, `snowflakeTimestamp(id)`, `getHiddenChannelMetadata(channel)`.
- Produces settings defaults: `hideUnreads=true`, `displayMode="lock"`, `showInfoScreen=true`.

- [ ] Create manifest matching repository conventions and point `main` at `src/index.ts`.
- [ ] Implement capability-based lookup of ChannelStore and PermissionStore using `findByProps`.
- [ ] Implement hidden-channel classification without modifying global permissions.
- [ ] Implement metadata normalization and snowflake timestamp helpers as pure functions where possible.
- [ ] Add settings UI using the same `storage` + `useProxy` + `Forms` pattern already used by `HideChannelListShortcuts`.
- [ ] Add lifecycle skeleton in `index.ts` with default initialization and centralized unpatch cleanup.
- [ ] Run repository build and fix all type/bundle errors before proceeding.

### Task 2: Reveal known hidden channels in the mobile channel list

**Files:**
- Create: `plugins/ShowHiddenChannels/src/patches/channelList.ts`
- Modify: `plugins/ShowHiddenChannels/src/index.ts`

**Interfaces:**
- Consumes: `isHiddenChannel`, real PermissionStore access, plugin storage.
- Produces: `patchChannelList(registerUnpatch): void`.

- [ ] Discover the guild channel-list model/store by stable method groups already present in Discord mobile, preferring model/filter hooks over component-wide patches.
- [ ] Patch only the filtering/model path needed to keep client-known inaccessible channel objects in their original category/order.
- [ ] If a narrow permission predicate must be intercepted, scope it to the channel-list model call path and restore the real result everywhere else.
- [ ] Add row decoration only through a stable channel-row/model hook; lock-style presentation is required, muted style is opportunistic.
- [ ] Fail closed if no safe list hook is found: do not fall back to global permission spoofing.
- [ ] Run build.

### Task 3: Add hidden-channel information screen and navigation guard

**Files:**
- Create: `plugins/ShowHiddenChannels/src/ui/HiddenChannelScreen.tsx`
- Create: `plugins/ShowHiddenChannels/src/patches/navigation.ts`
- Modify: `plugins/ShowHiddenChannels/src/index.ts`

**Interfaces:**
- Consumes: `isHiddenChannel`, `isTextLikeChannel`, `getHiddenChannelMetadata`, `storage.showInfoScreen`.
- Produces: `patchNavigation(registerUnpatch): void`.

- [ ] Implement read-only React Native screen showing only locally available channel metadata.
- [ ] Resolve the mobile navigation/router entry point using narrow property discovery.
- [ ] Intercept only navigation to hidden guild channels.
- [ ] For hidden text-like channels, open the information screen when `showInfoScreen=true`; otherwise consume the tap.
- [ ] Leave visible-channel navigation untouched.
- [ ] Never populate the screen by fetching messages or privileged channel data.
- [ ] Run build.

### Task 4: Guard message fetches, voice/stage joins, and unread state

**Files:**
- Create: `plugins/ShowHiddenChannels/src/patches/fetching.ts`
- Create: `plugins/ShowHiddenChannels/src/patches/voice.ts`
- Create: `plugins/ShowHiddenChannels/src/patches/unreads.ts`
- Modify: `plugins/ShowHiddenChannels/src/index.ts`

**Interfaces:**
- Consumes: `isHiddenChannel`, `isVoiceLikeChannel`, plugin storage.
- Produces: `patchFetching`, `patchVoice`, `patchUnreads`.

- [ ] Discover the message-fetch action by a distinctive method group and intercept hidden-channel requests before network work begins.
- [ ] Return a benign no-op value for hidden-channel fetches while delegating visible channels with original arguments.
- [ ] Discover voice/stage channel selection/connect actions and suppress only hidden-channel targets.
- [ ] Discover unread predicates/count helpers and force false/zero for hidden channels only when `hideUnreads=true`.
- [ ] Make every patch independently optional and shape-check target functions before patching.
- [ ] Run build.

### Task 5: Hardening and repository integration

**Files:**
- Modify: `plugins/ShowHiddenChannels/src/index.ts`
- Modify as needed: all files under `plugins/ShowHiddenChannels/src/`
- Modify: `README.md` only if plugin inventory/install links are maintained there.

**Interfaces:**
- Consumes all patch modules.
- Produces a complete plugin that unloads cleanly and degrades safely when Discord internals move.

- [ ] Ensure each patch registration is wrapped in a safe registrar and every successful patch contributes an unpatch callback.
- [ ] Ensure unload unwinds callbacks in reverse order without throwing.
- [ ] Audit all original-function calls for `orig(...args)` rather than passing an argument array accidentally.
- [ ] Audit for accidental global permission overrides, React/JSX interception, message reads, or obfuscation-experiment changes; none are permitted.
- [ ] Run `npm run build`/`node build.mjs` and confirm all plugins bundle successfully.
- [ ] Inspect generated ShowHiddenChannels output/manifest in the build artifacts if produced by the repository build script.
- [ ] Commit the implementation in reviewable slices, then perform a final diff review against the design spec.

## Device Smoke Test Checklist

- [ ] Existing visible text/voice channels behave exactly as before.
- [ ] A client-known inaccessible channel appears in its expected category/order.
- [ ] Hidden text-like channel tap opens the information screen instead of normal chat.
- [ ] No message request is emitted for a hidden channel.
- [ ] Hidden voice/stage channel cannot be joined.
- [ ] Hidden channel unread decorations disappear with `hideUnreads=true`.
- [ ] Disabling the plugin restores native behavior.
- [ ] If Discord supplies only `No Access`/other obfuscated metadata, the plugin displays that value and does not fabricate the original name.
