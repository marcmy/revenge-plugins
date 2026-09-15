# MessageHistory Row-Overlay Redesign

## Status

Approved design for replacing MessageHistory's synthetic-message reinjection path with a render-only deleted-message overlay while preserving the existing edit-history user experience.

## Problem

MessageHistory currently persists deleted-message records and attempts to make them visible after restart by creating synthetic Discord messages and reinjecting them through Discord's Flux/message-loading paths. The current implementation also rewrites live `MESSAGE_DELETE` events into `MESSAGE_UPDATE` events to keep freshly deleted rows visible.

This creates several classes of failure:

- saved deleted rows are injected into message batches that do not necessarily cover the deleted message's original timestamp, so rows can appear in the wrong position;
- later real `LOAD_MESSAGES_SUCCESS` batches can overwrite synthetic rows, causing flash/disappear/reappear behavior;
- dismissing a saved deleted message must coordinate MessageHistory storage, synthetic message tracking, Discord's message store, and later reinjection, which can fail or re-create rows;
- repeated dismissals can cause excessive Flux/store activity and visible lag;
- rewriting a real `MESSAGE_DELETE` prevents other Discord stores from receiving the event they expect;
- synthetic rows use normal Discord message state and flags for something that is actually plugin-owned presentation state;
- the runtime message cache is unbounded and can retain large numbers of raw message objects.

The redesign removes MessageHistory deleted rows from Discord's message state entirely.

## Goals

1. Persist deleted-message history across Discord/Revenge restarts.
2. Render saved deleted messages inline at their original chronological position when that portion of history is loaded.
3. Never insert a saved deleted message into Discord's `MessageStore`, `ChannelMessages`, Flux message lifecycle, or persistence layer after Discord has deleted it.
4. Let real `MESSAGE_DELETE` events proceed through Discord unchanged.
5. Make inline dismissal deterministic, cheap, and permanent for the inline chat presentation while retaining the history record for browsing.
6. Preserve the existing edit-history UX, while making edit capture safe for partial `MESSAGE_UPDATE` payloads.
7. Bound runtime caching and eliminate synthetic-message/session tracking that exists only to support reinjection.
8. Add regression coverage for the failure modes seen on-device: wrong placement, flash/disappear, reappearance after dismissal, duplicate placement, and lag from repeated dismissals.

## Non-goals

- Reconstructing every Discord message feature perfectly after deletion.
- Making deleted rows part of Discord's canonical message state.
- Restoring deleted messages to search, pins, replies, inbox, thread stores, notifications, database caches, or other Discord subsystems.
- Changing the general history retention limits unless required for the new data model.
- Replacing the existing history browser or edit-history action-sheet UX beyond what is needed for correctness.

## Core invariant

A saved deleted message may exist in MessageHistory storage and in the transient native chat row stream, but it must never exist in Discord's canonical message store after Discord has processed the real deletion.

This invariant is the primary architectural constraint. Any implementation that requires synthetic `MESSAGE_CREATE`, synthetic `MESSAGE_UPDATE`, `ChannelMessages.commit()`, or mutation of the original `MESSAGE_DELETE` event violates the design.

## Architecture

### 1. Capture layer

MessageHistory continues to observe message-related Flux events before Discord processes them so it can capture the pre-change state, but it does not rewrite those events.

#### Delete capture

On a real `MESSAGE_DELETE`:

1. Normalize `channelId` and `messageId`.
2. Resolve the current real message from the bounded runtime cache first, then Discord's current message store as fallback.
3. Snapshot the message into an immutable MessageHistory record.
4. Persist the delete record.
5. Allow the original `MESSAGE_DELETE` event to continue unchanged.

The plugin does not dispatch any compensating event and does not place a synthetic message into Discord state.

#### Edit capture

On `MESSAGE_UPDATE`, treat the payload as potentially partial.

1. Resolve the current full message state from the runtime cache/Discord store.
2. Merge the incoming partial payload into that previous state using Discord-like partial-update semantics.
3. Only create an edit-history record if the effective message content actually changed.
4. Update the bounded runtime cache with the merged result.

Metadata-only updates, embed refreshes, reaction-like message updates, and other partial payloads must not generate bogus blank or duplicate edit-history records.

### 2. Persisted history store

Persisted history remains MessageHistory's source of truth.

Delete records store at least:

- record ID;
- `kind: "delete"`;
- channel ID;
- guild ID when available;
- message ID;
- author identity/display data needed for local rendering;
- message content;
- attachment/embed metadata already retained by the plugin;
- original message timestamp (`messageTimestamp`), used for row placement;
- deletion/capture timestamp (`timestamp`), used for history browsing/retention;
- `inlineHidden: boolean`, default `false`.

`inlineHidden` means the user dismissed the saved deletion from inline chat. It does not remove the saved history record.

Existing records without `inlineHidden` are migrated/normalized as `false`.

The existing global/per-channel/per-message/max-age retention logic continues to apply to both edit and delete records.

### 3. Bounded runtime cache

The runtime cache is only a capture aid for recovering the previous real message state.

Requirements:

- hard upper bound by entry count;
- recency-based eviction (simple LRU/FIFO is sufficient);
- no persisted ownership semantics;
- no synthetic deleted messages stored in the cache;
- cache cleared on plugin unload;
- cache entries should retain only what capture needs rather than becoming a parallel unbounded copy of Discord's active message universe.

A reasonable first bound is 500-1000 recent message snapshots, but the implementation plan should choose a value based on existing plugin behavior and testability rather than coupling it to LongScreenshotFix's target.

### 4. Render layer: row-stream overlay

Patch Discord's native `createChannelStream` path rather than Discord's canonical message store.

For each channel render:

1. Call Discord's original `createChannelStream` and obtain its normal row descriptors.
2. Identify the real message rows in the stream and determine the loaded real-message time window.
3. Read non-hidden persisted delete records for the same channel.
4. Select only records whose original message timestamp belongs to the currently loaded real-message window.
5. Convert eligible saved records into transient renderer-compatible message-row descriptors/MessageRecords.
6. Merge them into the row stream using stable chronological ordering.
7. Return the combined row stream.

The generated tombstone exists only for that render pass. It is not committed to `MessageStore` or `ChannelMessages` and is never emitted through Flux.

### 5. Placement and pagination rules

Placement must be conservative and deterministic.

#### Loaded-window eligibility

Let `oldestLoaded` and `newestLoaded` be the chronological bounds of real messages currently represented by the channel stream.

A saved delete is eligible when its original message ordering key falls within the loaded window.

If a saved delete is older than `oldestLoaded` and Discord reports `hasMoreBefore`, it is not rendered yet. It becomes eligible only after the user or another plugin loads enough older real history for the window to reach it.

At the live/newest edge, recently deleted messages are eligible when their original ordering key lies in the loaded window. If the row is newer than the newest loaded real message because it was just deleted from the live edge, the renderer may include it as an edge case only when the channel is at the present end (`hasMoreAfter === false`) and its timestamp is no older than the newest loaded region. The implementation plan should define this edge case with explicit tests rather than relying on wall-clock heuristics.

#### Ordering key

Use original message timestamp as the primary key and Discord snowflake/message ID as the stable tie-breaker. This keeps multiple deleted records in the same gap deterministic.

#### No duplicate reinjection

A delete record is considered once per row-stream render. It is never attached to arbitrary load events. Therefore the same persisted record cannot be added once per batch or repeatedly re-dispatched.

### 6. Tombstone row representation

The inline deleted row should resemble the current MessageHistory experience, e.g. `[deleted] <original text>`, while remaining clearly local/plugin-owned.

Requirements:

- no Discord `EPHEMERAL` flag abuse;
- no synthetic-message marker required by Discord stores because the row never enters those stores;
- preserve original author display information when available;
- preserve original message timestamp;
- preserve attachment/embed metadata where practical for local display;
- degrade gracefully when saved media URLs are no longer retrievable;
- do not attempt to recreate polls, interaction state, reply-store state, pins, notifications, or other canonical Discord features.

If the native renderer requires a `MessageRecord`, construct it transiently for rendering only.

### 7. Dismissal semantics

Inline dismissal is presentation state, not history deletion.

When the user chooses `Hide Deleted Message` on a MessageHistory tombstone:

1. Set that delete record's `inlineHidden` to `true` in MessageHistory storage.
2. Increment/update a MessageHistory render revision or equivalent plugin-local invalidation signal.
3. Trigger the smallest safe chat re-render available.
4. Do not dispatch any Discord message event.
5. Do not mutate Discord stores.

The saved record remains visible in MessageHistory's history/deleted-message browser until normal retention or explicit history deletion removes it.

Repeated dismissals are O(1) storage/state updates plus a bounded render invalidation, not message-store mutation loops.

### 8. Clearing history

Clearing one record, a channel, or all history must update both persisted records and any plugin-local derived indexes/cache used by the render layer.

Because deleted rows do not live in Discord's stores, there is no synthetic runtime state to reconcile or remove.

Clearing history must cause the inline overlay to stop producing those rows on the next render.

### 9. Render invalidation

The plugin must not use fake Flux message events as a refresh mechanism.

Preferred order:

1. identify a native/local channel-stream or row-manager invalidation mechanism that can cause `createChannelStream` to run again;
2. if available, call the smallest safe invalidation path after MessageHistory presentation state changes;
3. otherwise rely on the next natural chat render and expose dismissal state immediately in plugin UI while avoiding synthetic Discord message traffic.

The implementation plan should verify the exact available runtime hook before choosing an invalidation method.

### 10. Action-sheet integration

The action-sheet patch should distinguish normal Discord messages from MessageHistory tombstone rows.

For real messages with saved edit/delete history, retain the existing history actions.

For a MessageHistory tombstone, provide at least:

- `View Message History` (or equivalent existing history action);
- `Hide Deleted Message`.

Avoid mutating a reused rows array repeatedly. The implementation should include an idempotence guard or generate a new rows array so rerenders cannot duplicate MessageHistory action rows.

## Data flow

### Real deletion

`MESSAGE_DELETE` observed -> snapshot current real message -> persist delete record -> original event continues unchanged -> Discord removes its message normally -> future channel render overlays persisted tombstone if eligible.

### Restart/reopen

Plugin loads persisted records -> Discord loads channel normally -> `createChannelStream` runs -> MessageHistory selects eligible non-hidden delete records for the loaded window -> transient tombstone rows are merged -> no Flux reinjection and no store mutation.

### Older-history load

Discord extends its real loaded window -> `createChannelStream` runs again -> additional saved deletes become eligible only when their original positions enter that window -> already visible records remain stably ordered -> no duplicates across batches.

### Inline dismissal

Long-press tombstone -> set `inlineHidden=true` -> invalidate/re-render -> overlay omits record -> history browser still contains it.

### Edit

Partial `MESSAGE_UPDATE` observed -> merge with previous full snapshot -> if effective content changed, persist previous content as edit record -> cache merged current state -> Discord processes original update unchanged.

## Failure handling

- If capture cannot resolve the deleted message contents, do not create a malformed tombstone record; log/debug the miss and allow Discord deletion normally.
- If row-generation patch discovery fails, MessageHistory still records and exposes history in its browser; inline deleted rendering is disabled rather than falling back to synthetic Flux reinjection.
- If transient tombstone conversion fails for one record, skip that record for the current render and log a bounded diagnostic; do not fail the entire channel stream.
- Corrupt/missing optional fields in old persisted records are normalized conservatively.
- Plugin unload removes patches and clears bounded runtime caches only; persisted history follows the existing `persistHistory` behavior.

## Migration

Existing persisted delete records are retained.

Migration rules:

- missing `inlineHidden` -> `false`;
- keep existing `messageTimestamp` when present;
- otherwise derive original placement time from the message snowflake, then fall back to the stored capture timestamp;
- old synthetic marker/EPHEMERAL assumptions are ignored by the new render path;
- existing reinjection debug logs may be retained for one version for troubleshooting or removed as dead UI/code during implementation; the implementation plan should prefer removing them if they no longer serve the redesigned architecture.

No migration should dispatch messages or attempt to clean synthetic rows from Discord state after restart; the old synthetic rows are session state and disappear naturally when the old plugin code is no longer active/reloaded.

## Code organization

The current `index.ts` mixes capture, persistence coordination, reinjection, action-sheet patching, and lifecycle concerns. The redesign should separate responsibilities enough to make the dangerous logic testable.

Suggested modules:

- `history.ts`: pure persisted-record operations, normalization, retention, ordering, migration;
- `capture.ts`: message snapshot/partial-update merge and bounded runtime cache;
- `overlay.ts`: loaded-window calculation, delete-record eligibility, row conversion/merge, render invalidation helpers;
- `actions.tsx` or existing UI module: tombstone/history actions and dismissal callbacks;
- `index.ts`: module discovery, patch registration, lifecycle wiring only.

Exact filenames can change during implementation if the repo's conventions suggest a better split, but the capture/store/render boundaries should remain explicit.

## Testing strategy

### Pure unit/regression tests

Add deterministic tests for:

- settings/history migration adds `inlineHidden=false` to legacy records;
- hidden delete records are excluded from inline candidates but retained by history queries;
- original message timestamp/snowflake placement ordering;
- loaded-window eligibility for records before, inside, and after the current window;
- records older than the window remain hidden while `hasMoreBefore=true`;
- multiple deletes in one gap have stable ordering;
- repeated row-stream generation does not duplicate tombstones;
- the same record does not move when older batches extend the window;
- partial `MESSAGE_UPDATE` merge preserves omitted content/attachments/etc.;
- metadata-only updates do not create edit-history records;
- true content edits do create the previous version exactly once;
- bounded runtime cache evicts old entries;
- inline dismissal updates only MessageHistory state and leaves the record browsable;
- repeated dismissals are idempotent;
- clear-history operations remove overlay candidates immediately;
- action-sheet augmentation is idempotent.

### Integration-style harness

Model a channel with multiple real pagination windows and saved deletes spread across them:

1. Render newest window: only deletes in that window appear.
2. Extend history backward: newly eligible deletes appear at their original positions; existing ones do not move or duplicate.
3. Dismiss several visible tombstones in rapid succession: all disappear from overlay state without Flux events.
4. Re-render and extend history again: dismissed records remain absent.
5. Simulate app restart by rebuilding runtime state from persisted records: non-hidden deletes return in the correct window; hidden deletes remain hidden.

This harness directly covers the user's observed failures.

### Build/runtime verification

- existing repository build must pass;
- MessageHistory pure tests must run in CI rather than existing only as a manual script;
- on-device verification should test live delete, restart/reopen, older-history load, repeated dismissals, and coexistence with LongScreenshotFix preloading.

## Interaction with LongScreenshotFix

The overlay design is intentionally compatible with LongScreenshotFix.

LongScreenshotFix may retain/preload a larger real-message window. MessageHistory simply sees that larger real window during row generation and makes more saved deletes eligible. It does not cache those hundreds of messages indefinitely and does not inject extra load events.

The two plugins may both patch `createChannelStream`; implementation must preserve patch composability by always calling the original/next patched function and transforming its returned rows without assuming it is the sole patch.

## Removed behavior/code

The redesign should delete, not preserve, the old reinjection machinery:

- synthetic `MESSAGE_CREATE`/`MESSAGE_UPDATE` helpers used for reinjection;
- mutation of real `MESSAGE_DELETE` into `MESSAGE_UPDATE`;
- `injectedDeletedMessages` tracking;
- `recentlyPreservedDeletes` workaround;
- batch reinjection into every `*LOAD*MESSAGE*` event;
- synthetic-dismiss consumption logic tied to Discord delete events;
- EPHEMERAL flag usage for MessageHistory tombstones;
- reinjection-specific debug logging/UI if it is no longer useful;
- any unbounded raw-message cache behavior.

Leaving dormant compatibility paths would reintroduce state ambiguity, so the implementation should prefer one architecture only.

## Success criteria

The redesign is complete when:

1. Deleting a message causes Discord to receive and process an unchanged `MESSAGE_DELETE`.
2. The deleted message remains available in persisted MessageHistory storage.
3. Inline deleted rows are generated only by the render overlay and never appear in Discord's canonical message stores.
4. After restart, a saved deleted row appears only when its original chronological position is inside the loaded real-message window.
5. Loading older history never causes an existing tombstone to jump to another position or duplicate.
6. Hiding a tombstone removes it from inline chat without deleting its saved history record.
7. Rapidly hiding multiple tombstones does not dispatch message events or create a growing synthetic-state workload.
8. Hidden tombstones do not return after later history loads or app restart.
9. Metadata-only partial message updates do not create false edit-history entries.
10. Runtime MessageHistory caching remains bounded.
11. The plugin continues to build and the new regression tests run successfully in CI.
