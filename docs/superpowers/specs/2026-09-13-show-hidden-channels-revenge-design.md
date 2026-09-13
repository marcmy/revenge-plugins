# Revenge ShowHiddenChannels Port Design

## Goal

Port the useful behavior of Vencord's `ShowHiddenChannels` plugin to Revenge on Discord Android using Revenge/Vendetta-native Metro discovery and runtime patching rather than attempting a literal desktop webpack port.

The plugin should show inaccessible guild channels in the channel list, preserve and display channel metadata that Discord actually provides to the client, clearly mark those channels as inaccessible, and prevent normal chat/voice behavior from treating them as usable channels.

## Scope

### Included in v1

- Reveal guild channels that fail the real `VIEW_CHANNEL` permission check when Discord still supplies their channel objects.
- Preserve normal category placement and channel ordering where the mobile channel-list model exposes enough information to do so.
- Centralize hidden-channel detection behind a helper that always evaluates the real permission state.
- Support a lock-style hidden-channel presentation on mobile.
- Optionally hide unread indicators for hidden channels.
- Route taps on hidden text/media/forum-style channels to a read-only hidden-channel information screen instead of normal chat.
- Show available metadata on that screen, including channel name, topic, type, creation time derived from the channel snowflake, last-message time when a last-message ID is available, and last-pin time when supplied.
- Prevent message fetching for hidden channels.
- Prevent joining hidden voice/stage channels.
- Prevent normal navigation paths from treating a hidden channel as readable.
- Fail individual patches independently when Discord changes a Metro module so one broken adapter does not prevent the whole plugin from loading.
- Keep the implementation split into focused modules rather than a single large `index.ts`.

### Explicitly out of scope

- Bypassing Discord's server-side private-channel metadata obfuscation or recovering metadata that Discord did not send to the client.
- Reproducing desktop-only Vencord UI or patches that have no mobile equivalent.
- Pretending hidden channels are globally readable by permanently overriding all `VIEW_CHANNEL` checks.
- Reading messages from inaccessible channels.
- Injecting or synthesizing channel names when only an obfuscated placeholder such as `No Access` is available.

## Design Principles

### Semantic port, not source port

Vencord patches desktop webpack modules and React components. Revenge operates on Discord Android's Metro modules and Vendetta/Revenge runtime patcher. The port should reproduce Vencord's user-visible behavior and defensive guards while using mobile-native hooks.

### Preserve the real permission result

A hidden channel is defined by the real Discord permission check, not by the plugin's altered rendering behavior. The plugin will expose a helper with behavior equivalent to:

```ts
isHiddenChannel(channel): boolean
```

The helper will:

1. Resolve a channel ID to a channel object when necessary.
2. Reject DMs, group DMs, categories, and malformed objects.
3. Evaluate the original `VIEW_CHANNEL` permission result without recursion through any visibility patch.
4. Return `true` only when the channel is a guild channel the current user cannot view.

This helper is the source of truth for all later guards.

### Avoid global permission spoofing

Older Vendetta hidden-channel plugins patched `Permissions.can(VIEW_CHANNEL, channel)` to return `true` almost everywhere. That is simple but causes unrelated Discord code to treat hidden channels as usable and forces many compensating patches.

The preferred implementation is hybrid:

- Relax filtering only at the channel-list/model boundary needed to keep hidden channel rows present.
- Leave normal permission semantics intact elsewhere.
- Add explicit guards for navigation, message fetching, unreads, and voice/stage selection.

If the current Discord mobile build offers no practical list-model hook and a narrow permission patch is required, it must be scoped to the channel-list construction path and must not become a process-wide `VIEW_CHANNEL => true` override.

## Proposed File Structure

```text
plugins/ShowHiddenChannels/
├── manifest.json
└── src/
    ├── index.ts
    ├── settings.tsx
    ├── core/
    │   └── hiddenChannel.ts
    ├── patches/
    │   ├── channelList.ts
    │   ├── fetching.ts
    │   ├── navigation.ts
    │   ├── unreads.ts
    │   └── voice.ts
    └── ui/
        └── HiddenChannelScreen.tsx
```

### `index.ts`

Lifecycle only. It initializes defaults, resolves and registers patch modules, stores unpatch callbacks, and unwinds them on unload. It should contain no channel-list implementation details.

### `core/hiddenChannel.ts`

Owns Discord module discovery needed for channel lookup and real permission checks. Exposes small, reusable helpers for hidden-state detection and metadata normalization.

### `patches/channelList.ts`

Locates the current mobile guild-channel list/model builder and prevents otherwise-known hidden guild channels from being discarded. It should preserve the original channel objects and ordering rather than constructing fake channels.

It also owns any mobile-specific row decoration necessary to show a lock/hidden style when a row represents a hidden channel.

### `patches/navigation.ts`

Intercepts navigation to hidden text-like channels and sends the user to the plugin's hidden-channel information view instead of opening normal chat. Normal channels must pass through untouched.

### `patches/fetching.ts`

Intercepts Discord's message-fetch entry point. Requests for hidden channels return without fetching. Requests for visible channels delegate to the original implementation unchanged.

### `patches/unreads.ts`

When `hideUnreads` is enabled, hidden channels contribute no unread state/badge. When disabled, the plugin avoids inventing unread state and leaves Discord's available state unchanged.

### `patches/voice.ts`

Prevents selecting/joining hidden voice and stage channels. Visible voice/stage channels delegate to Discord unchanged.

### `ui/HiddenChannelScreen.tsx`

Read-only information screen rendered from the already-present channel object. It must not fetch messages or other privileged content to populate itself.

## Settings

v1 intentionally keeps the settings small and mobile-relevant.

### `hideUnreads`

- Type: boolean
- Default: `true`
- Behavior: hidden channels do not appear unread or contribute unread-channel decorations when enabled.

### `displayMode`

- Type: select
- v1 values:
  - `lock` — render hidden channels in a normal list position with a lock-style affordance.
  - `muted` — use a subdued/muted presentation when a safe mobile renderer hook exists.
- Default: `lock`
- If the mobile renderer does not expose a stable way to implement `muted`, the plugin may temporarily expose only `lock` rather than patch React globally.

### `showInfoScreen`

- Type: boolean
- Default: `true`
- Behavior: tapping a hidden text-like channel opens `HiddenChannelScreen`. If disabled, taps are ignored rather than opening normal chat.

## Runtime Data Flow

### Plugin load

1. Initialize setting defaults.
2. Resolve the small set of Discord modules required by the core helper and each patch adapter.
3. Register patch modules independently through a safe patch-registration helper.
4. Keep each returned unpatch function in a shared lifecycle collection.
5. A missing module disables only that feature patch and does not abort plugin load.

### Channel-list construction

1. Discord builds the guild channel list/model.
2. `channelList.ts` observes the model or filtering stage before hidden channel rows are discarded.
3. For each real channel object, the plugin calls `isHiddenChannel(channel)`.
4. Known hidden channels survive the visibility filtering needed to produce rows.
5. The row renderer applies the configured inaccessible style without mutating the channel's actual permission data.

### Hidden channel tap

1. User taps a hidden row.
2. `navigation.ts` evaluates `isHiddenChannel(channel)` using the real permission result.
3. If visible, original Discord navigation runs unchanged.
4. If hidden and `showInfoScreen` is enabled, normal chat navigation is suppressed and the information screen is shown.
5. If hidden and `showInfoScreen` is disabled, the tap is consumed without entering chat.

### Message fetching

1. Discord attempts to fetch messages for a channel.
2. `fetching.ts` resolves the request channel.
3. If hidden, return without network fetch.
4. Otherwise call the original method with the original arguments.

### Voice/stage selection

1. Discord attempts to select/connect to a voice or stage channel.
2. `voice.ts` resolves the target channel.
3. If hidden, suppress the connection attempt.
4. Otherwise delegate unchanged.

## Hidden Channel Information Screen

The screen should use only metadata already present in the client channel object.

Preferred fields:

- Channel name, including Discord-provided placeholder names when that is all the client has.
- Channel type.
- Topic or `No topic.`
- Creation time derived from the channel snowflake.
- Last-message time derived from `lastMessageId`, when present.
- Last-pin time from `lastPinTimestamp`, when present.

The screen should state that the channel is inaccessible. It should not imply that the plugin can read channel messages.

If Discord supplies an obfuscated name such as `No Access`, the UI displays that value rather than attempting recovery.

## Metro Module Discovery Strategy

Module lookups should use narrow capability-based searches such as `findByProps` and `findByName` only where component names remain stable enough to be useful.

Each patch module owns its discovery logic and validates method shapes before patching. A module reference is considered usable only when the target method is actually a function.

Do not patch `React.createElement`, JSX factories, or broad renderer primitives. Previous work in this repository already follows this rule for channel-list shortcut patches, and the new plugin should retain it.

Where Discord has renamed a module, prefer discovering by a distinctive group of method/property names rather than by a single fragile component name.

## Error Handling and Compatibility

All patch registration goes through a helper that catches discovery/patch errors and stores successful unpatch functions.

A failed patch must degrade as narrowly as possible:

- Channel-list patch unavailable: no hidden rows are revealed; other guards remain harmless.
- Navigation patch unavailable: hidden rows must not be made tappable through an unsafe fallback.
- Fetch patch unavailable: the channel-list/navigation implementation must avoid normal chat entry rather than knowingly causing message fetches.
- Voice patch unavailable: hidden voice/stage rows should not be exposed as joinable controls.
- Unread patch unavailable: omit the unread customization rather than patching global state generically.

The plugin should prefer losing a feature after a Discord update over applying a broad, uncertain patch to unrelated runtime code.

## Testing Strategy

### Pure helper tests

Add testable functions for behavior that does not require a live Metro runtime, including:

- Skipped channel-type classification.
- Snowflake timestamp conversion/format preparation where implemented locally.
- Metadata normalization and fallback labels.
- Guard predicates driven by injected permission/channel lookup functions.

### Build verification

The repository's existing build pipeline must successfully bundle the plugin through `node build.mjs` with the current Vendetta type definitions.

### Static/runtime-shape checks

Patch adapters should validate discovered targets before calling the patcher. Build-time tests can exercise exported predicate/helper logic with mock-shaped objects, but should not attempt to simulate the entire Discord Metro runtime.

### Device smoke test

A real Revenge/Discord Android smoke test is required because Metro module availability is runtime-specific. Verify:

1. Visible channels behave exactly as before.
2. Hidden channels appear in their expected category/list position when Discord supplies them.
3. Hidden text-like channel tap opens the info screen rather than chat.
4. Hidden channels do not trigger message fetches.
5. Hidden voice/stage channels cannot be joined.
6. Hidden channels do not show unreads when `hideUnreads=true`.
7. Plugin unload restores original behavior without restarting Revenge when the patched modules support clean unpatching.
8. An obfuscated/withheld channel name remains a fallback such as `No Access` and is not fabricated.

## Success Criteria

The port is successful when Revenge provides the same practical hidden-channel experience as Vencord wherever Discord Android exposes equivalent client-side data and hooks, while keeping real permission semantics intact outside the narrow rendering/navigation paths required by the feature.

The implementation must remain maintainable across Discord mobile updates by isolating Metro lookups and patch logic into small adapters and by failing closed when a runtime hook can no longer be identified safely.
