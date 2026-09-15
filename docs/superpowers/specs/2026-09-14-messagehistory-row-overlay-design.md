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

If legacy storage contains more than one delete record for the same `channelId + messageId`, history browsing may retain those records, but inline rendering must collapse them to one tombstone using the newest delete record as the canonical inline record. Hiding that tombstone marks all matching delete records for that message as `inlineHidden=true` so a legacy duplicate cannot make it reappear later.

The existing global/per-channel/per-message/max-age retention logic continues to apply to both edit and delete records.

### 3. Bounded runtime cache

The runtime cache is only a capture aid for recovering the previous real message state.

Requirements:

- hard limit of 750 message snapshots;
- recency-based eviction (LRU preferred; FIFO acceptable only if LRU would materially complicate the implementation);
- no persisted ownership semantics;
- no synthetic deleted messages stored in the cache;
- cache cleared on plugin unload;
- cache entries retain only fields needed for capture/history rather than becoming a parallel copy of Discord's message universe.

The bound is intentionally independent of LongScreenshotFix's preload target.

### 4. Render layer: row-stream overlay

Patch Discord's native `createChannelStream` path rather than Discord's canonical message store.

For each channel render:

1. Call Discord's original/next-patched `createChannelStream` and obtain its normal row descriptors.
2. Identify real message rows and derive their ordering keys.
3. Read non-hidden persisted delete records for the same channel and collapse legacy duplicates by `channelId + messageId`.
4. Select only records eligible for the currently loaded real-message window.
5. Convert eligible saved records into transient renderer-compatible message-row descriptors/MessageRecords.
6. Merge them into the row stream using stable chronological ordering.
7. Return the combined row stream.

The generated tombstone exists only for that render pass. It is not committed to `MessageStore` or `ChannelMessages` and is never emitted through Flux.

### 5. Placement and pagination rules

Placement is conservative and deterministic.

#### Ordering key

Each real or saved message uses:

1. original message timestamp as the primary ordering value;
2. Discord snowflake/message ID as the stable tie-breaker.

When the timestamp is unavailable for a saved record, derive it from the snowflake; only then fall back to the record's capture timestamp.

#### Loaded-window eligibility

Let `oldestLoaded` and `newestLoaded` be the oldest/newest ordering keys among real message rows in the current stream.

The effective render window is:

- lower bound = `oldestLoaded` while `hasMoreBefore === true`;
- lower bound = negative infinity while `hasMoreBefore === false`;
- upper bound = `newestLoaded` while `hasMoreAfter === true`;
- upper bound = positive infinity while `hasMoreAfter === false`.

A saved delete is eligible only when its ordering key is inside that effective window.

Consequences:

- while older history still exists, deletes older than the oldest loaded real message do not appear prematurely;
- once Discord reaches the beginning (`hasMoreBefore === false`), saved deletes older than the oldest surviving real message may correctly appear at the beginning;
- at the live end (`hasMoreAfter === false`), saved deletes newer than the newest surviving real message may correctly appear at the end, including a just-deleted newest message or a channel whose later real messages were also deleted;
- extending history changes only the applicable boundary; already eligible tombstones keep the same ordering relative to real messages.

If there are no real message rows:

- when both `hasMoreBefore === false` and `hasMoreAfter === false`, all non-hidden saved deletes for that channel are eligible and are sorted normally;
- otherwise render no saved deletes until a real boundary is available, because placement would be ambiguous.

#### No duplicate reinjection

A persisted message identity contributes at most one tombstone to one row-stream render. The overlay is recomputed from storage each render; no per-batch injection state is carried forward.

### 6. Tombstone row representation

The inline deleted row should resemble the current MessageHistory experience, e.g. `[deleted] <original text>`, while remaining clearly local/plugin-owned.

Requirements:

- no Discord `EPHEMERAL` flag abuse;
- no Flux-facing synthetic-message marker is needed because the row never enters Discord stores;
- a plugin-local marker may be attached only to the transient row/MessageRecord so the action-sheet layer can identify a tombstone;
- preserve original author display information when available;
- preserve original message timestamp;
- preserve attachment/embed metadata where practical for local display;
- degrade gracefully when saved media URLs are no longer retrievable;
- do not attempt to recreate polls, interaction state, reply-store state, pins, notifications, or other canonical Discord features.

If the native renderer requires a `MessageRecord`, construct it transiently for rendering only.

### 7. Dismissal semantics

Inline dismissal is presentation state, not history deletion.

When the user chooses `Hide Deleted Message` on a MessageHistory tombstone:

1. Mark every delete record matching that `channelId + messageId` as `inlineHidden=true`.
2. Update any plugin-local derived index/revision.
3. Cause the current channel row stream to regenerate through a non-message-event invalidation path.
4. Do not dispatch any Discord message event.
5. Do not mutate Discord stores.

The saved record remains visible in MessageHistory's history/deleted-message browser until normal retention or explicit history deletion removes it.

Repeated dismissal of an already-hidden tombstone is idempotent and performs no additional work beyond confirming the state.

### 8. Clearing history

Clearing one message, a channel, or all history updates persisted records and any plugin-local derived index/cache used by the render layer.

Because deleted rows do not live in Discord's stores, there is no synthetic runtime state to reconcile or remove.

Clearing history must make affected tombstones absent on the next/current regenerated row stream.

### 9. Render invalidation

The plugin must not use fake Flux message events as a refresh mechanism.

The implementation must locate a safe native/local invalidation surface that causes the active channel's row stream to be regenerated without changing Discord message state. Candidate surfaces may include the native row manager/channel-stream sequencing state, but the exact method is an implementation detail to verify against the current client.

Required behavior:

- hiding or clearing an inline tombstone updates the currently visible channel without requiring navigation away/reopen;
- multiple rapid dismissals are coalesced into at most one pending refresh per event-loop/render turn;
- failure to locate a safe invalidation hook disables immediate inline refresh and logs a bounded diagnostic rather than falling back to synthetic Flux message events.

### 10. Action-sheet integration

The action-sheet patch distinguishes normal Discord messages from MessageHistory tombstone rows.

For real messages with saved edit/delete history, retain the existing history actions.

For a MessageHistory tombstone, provide at least:

- `View Message History` (or equivalent existing history action);
- `Hide Deleted Message`.

Action-sheet augmentation must be idempotent. It must not repeatedly splice duplicate MessageHistory rows into a reused tree/array on rerender.

## Data flow

### Real deletion

`MESSAGE_DELETE` observed -> snapshot current real message -> persist delete record -> original event continues unchanged -> Discord removes its message normally -> row-overlay invalidation/render makes the persisted tombstone visible if eligible.

### Restart/reopen

Plugin loads persisted records -> Discord loads channel normally -> `createChannelStream` runs -> MessageHistory selects eligible non-hidden delete records for the effective window -> transient tombstone rows are merged -> no Flux reinjection and no store mutation.

### Older-history load

Discord extends its real loaded window -> `createChannelStream` runs again -> additional saved deletes become eligible only when the boundary reaches them -> already visible records remain stably ordered -> no duplicates across batches.

### Inline dismissal

Long-press tombstone -> set matching delete records `inlineHidden=true` -> coalesced local row invalidation -> overlay omits tombstone -> history browser still contains the records.

### Edit

Partial `MESSAGE_UPDATE` observed -> merge with previous full snapshot -> if effective content changed, persist previous content as an edit record -> cache merged current state -> Discord processes original update unchanged.

## Failure handling

- If capture cannot resolve deleted-message contents, do not create a malformed tombstone record; log/debug the miss and allow Discord deletion normally.
- If row-generation patch discovery fails, MessageHistory still records and exposes history in its browser; inline deleted rendering is disabled rather than falling back to synthetic Flux reinjection.
- If transient tombstone conversion fails for one record, skip that record for the current render and log a bounded diagnostic; do not fail the entire channel stream.
- Corrupt/missing optional fields in old persisted records are normalized conservatively.
- If immediate row invalidation is unavailable, never violate the core invariant to simulate it; inline state will correct on the next natural render and diagnostics will identify the missing capability.
- Plugin unload removes patches and clears bounded runtime caches only; persisted history follows the existing `persistHistory` behavior.

## Migration

Existing persisted edit/delete records are retained.

Migration rules:

- missing `inlineHidden` -> `false`;
- keep existing `messageTimestamp` when present;
- otherwise derive original placement time from the message snowflake, then fall back to stored capture timestamp;
- duplicate legacy delete records remain available in history browsing but collapse to one inline tombstone;
- old synthetic marker/EPHEMERAL assumptions are ignored by the new render path;
- reinjection-specific debug logs/settings/UI are removed because the reinjection architecture no longer exists.

No migration dispatches messages or attempts to clean synthetic rows from Discord state. Old synthetic rows were session state and disappear naturally when the old plugin implementation unloads/restarts.

## Code organization

The current `index.ts` mixes capture, persistence coordination, reinjection, action-sheet patching, and lifecycle concerns. The redesign separates these responsibilities so the dangerous logic is independently testable.

Target modules:

- `history.ts`: pure persisted-record operations, normalization, retention, ordering, migration, hide/unhide state;
- `capture.ts`: snapshot creation, partial-update merge, bounded 750-entry runtime cache;
- `overlay.ts`: effective-window calculation, candidate deduplication/eligibility, transient row conversion/merge, refresh coalescing;
- `ui.tsx`/action helper: tombstone/history actions and dismissal callbacks;
- `index.ts`: module discovery, patch registration, lifecycle wiring only.

`debug.tsx` reinjection-specific functionality is removed unless a small generic diagnostic facility is still required by implementation-time discovery; it must not retain reinjection concepts.

## Testing strategy

### Pure unit/regression tests

Add deterministic tests for:

- migration adds `inlineHidden=false` to legacy records;
- hidden delete records are excluded from inline candidates but retained by history queries;
- legacy duplicate delete records collapse to one inline tombstone;
- hiding a duplicated legacy message identity hides all matching delete records;
- original message timestamp/snowflake placement ordering;
- effective window bounds for all four `hasMoreBefore/hasMoreAfter` edge combinations;
- empty real window behavior;
- records before, inside, and after the effective window;
- multiple deletes in one gap have stable ordering;
- repeated row-stream generation does not duplicate tombstones;
- the same record does not move when older batches extend the window;
- partial `MESSAGE_UPDATE` merge preserves omitted content/attachments/etc.;
- metadata-only updates do not create edit-history records;
- true content edits create the previous version exactly once;
- 750-entry cache evicts least-recently-used entries;
- inline dismissal updates only MessageHistory state and leaves the record browsable;
- repeated dismissals are idempotent;
- multiple rapid dismissals coalesce refresh work;
- clear-history operations remove overlay candidates;
- action-sheet augmentation is idempotent.

### Integration-style harness

Model a channel with multiple real pagination windows and saved deletes spread across them:

1. Render newest window: only deletes in the effective window appear, including legitimate live-edge deletes when `hasMoreAfter=false`.
2. Extend history backward: newly eligible deletes appear at their original positions; existing ones do not move or duplicate.
3. Reach `hasMoreBefore=false`: legitimate deletes older than the oldest surviving real message appear at the beginning.
4. Dismiss several visible tombstones in rapid succession: all become hidden with no Flux message events and one coalesced refresh.
5. Re-render and extend history again: dismissed records remain absent.
6. Simulate app restart from persisted records: non-hidden deletes return in the correct window; hidden deletes remain hidden.
7. Simulate duplicate legacy delete records: only one tombstone appears and dismissal prevents all duplicates from returning.

This harness directly covers the observed failures.

### Build/CI/runtime verification

- existing repository build must pass;
- MessageHistory regression tests must be a normal CI step rather than a manual-only script;
- on-device verification must cover live delete, restart/reopen, older-history load, channel beginning/end boundaries, repeated rapid dismissals, clearing history, action-sheet rerendering, and coexistence with LongScreenshotFix preloading.

## Interaction with LongScreenshotFix

The overlay design is intentionally compatible with LongScreenshotFix.

LongScreenshotFix may retain/preload a larger real-message window. MessageHistory sees that larger real window during row generation and makes additional saved deletes eligible according to the same boundary rules. It does not cache those hundreds of raw messages indefinitely and does not inject extra load events.

Both plugins may patch `createChannelStream`; MessageHistory must call the original/next patched function first and transform the returned rows without assuming it is the sole patch. It must preserve unknown/non-message row descriptors, including LongScreenshotFix behavior.

## Removed behavior/code

The redesign deletes, rather than preserves, the old reinjection machinery:

- synthetic `MESSAGE_CREATE`/`MESSAGE_UPDATE` helpers used for reinjection;
- mutation of real `MESSAGE_DELETE` into `MESSAGE_UPDATE`;
- `injectedDeletedMessages` tracking;
- `recentlyPreservedDeletes` workaround;
- batch reinjection into every `*LOAD*MESSAGE*` event;
- synthetic-dismiss consumption logic tied to Discord delete events;
- EPHEMERAL flag usage for MessageHistory tombstones;
- reinjection-specific debug logging/settings/UI;
- unbounded raw-message cache behavior.

Leaving dormant compatibility paths would reintroduce state ambiguity, so there is one delete-history architecture only: persisted records plus a render overlay.

## Success criteria

The redesign is complete when:

1. Deleting a message causes Discord to receive and process an unchanged `MESSAGE_DELETE`.
2. The deleted message remains available in persisted MessageHistory storage.
3. Inline deleted rows are generated only by the render overlay and never appear in Discord's canonical message stores.
4. After restart, a saved deleted row appears only when its original chronological position is inside the effective loaded window, including correct open-ended beginning/live-edge behavior.
5. Loading older history never causes an existing tombstone to jump to another position or duplicate.
6. Hiding a tombstone removes it from inline chat without deleting its saved history record.
7. Rapidly hiding multiple tombstones dispatches no message events, coalesces refresh work, and creates no growing synthetic-state workload.
8. Hidden tombstones do not return after later history loads or app restart.
9. Metadata-only partial message updates do not create false edit-history entries.
10. Runtime MessageHistory caching never exceeds 750 snapshots.
11. Legacy duplicate delete records cannot produce duplicate inline tombstones or defeat dismissal.
12. The plugin continues to build and the new regression suite runs successfully in CI.
