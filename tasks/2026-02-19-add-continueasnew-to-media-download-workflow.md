# Task: Add continueAsNew to media download workflow

**Status:** Complete
**Created:** 2026-02-19
**Completed:** 2026-02-20
**Source:** ~/.claude/plans/polished-juggling-spring.md

## Plan

### Context

The `mediaDownloadWorkflow` processes each media item as a separate activity call (~3 history events each). With thousands of downloads, the workflow exceeds Temporal's warning thresholds (10K events / 10MB) and will be force-terminated at the hard limit (50K events / 50MB). Currently no workflow in the codebase uses `continueAsNew`. The fix adds periodic history resets via `continueAsNew`, carrying forward accumulated counters and signal state.

### Approach

After each individual item download (per-item granularity, ~3 history events), check `wf.workflowInfo().continueAsNewSuggested` (server hint), `historyLength >= threshold` (default 5000), or `historySize >= 5MB`. When triggered, set `state.shouldContinueAsNew = true`, break out of the processing loop, and call `wf.continueAsNew()` with carry-forward state in the input — placed outside the try/catch so the thrown `ContinueAsNew` error propagates.

Parent compatibility is preserved — the orchestrator signals via `getExternalWorkflowHandle(workflowId)` which targets the latest run automatically after `continueAsNew`.

### Changes

#### 1. `src/temporal/shared/media-download-types.ts`

- Add `MediaDownloadCarryForward` interface with: `downloaded`, `failed`, `skipped`, `pendingTriggers`, `drainAndExitRequested`, `startTimeMs`
- Add `continueAsNewThreshold?: number` to `MediaDownloadWorkflowInput`
- `_carryForward` is NOT on this public type — it lives on the workflow-internal `MediaDownloadWorkflowFullInput` in `index.ts`

#### 2. `src/temporal/workflows/media-download/runtime.ts`

- Add `shouldContinueAsNew: boolean` to `MediaDownloadRuntimeState`
- Update `createMediaDownloadRuntimeState(awaitTriggers, carryForward?)` to initialize counters and signal state from carry-forward when present

#### 3. `src/temporal/workflows/media-download/loop.ts`

- Add exported `checkContinueAsNew(threshold)` helper using `wf.workflowInfo()` — checks `continueAsNewSuggested`, `historyLength`, and `historySize`
- Export `DEFAULT_CONTINUE_AS_NEW_THRESHOLD` (5000); `DEFAULT_HISTORY_SIZE_THRESHOLD` (5MB) is module-private
- After each `processSinglePass()`, check `state.shouldContinueAsNew` (set by per-item checks in `pass.ts`) and break
- Check in both standalone and `awaitTriggers` paths

#### 4. `src/temporal/workflows/media-download/index.ts`

- Initialize `startTime` from `_carryForward.startTimeMs` when present
- Pass `_carryForward` to `createMediaDownloadRuntimeState`
- Compute `effectiveLimit` from original `limit` minus items already processed in prior runs
- After loop exits normally: if `state.shouldContinueAsNew`, call `wf.continueAsNew<typeof mediaDownloadWorkflow>({...input, _carryForward: {...}})` — placed outside the try/catch so the thrown `ContinueAsNew` error propagates to Temporal
- Add `ContinueAsNew` re-throw guard in the catch block for future-proofing

#### 5. `tests/media-download-workflow.test.ts`

- Add `workflowInfo`, `continueAsNew`, and `ContinueAsNew` to the Temporal mock
- Test: triggers `continueAsNew` when `historyLength` exceeds threshold
- Test: initializes counters from carry-forward state
- Test: `continueAsNewSuggested` from server triggers it
- Test: effective limit accounts for carry-forward
- Existing tests remain unchanged (mock defaults keep threshold inactive)

### Verification

```bash
pnpm test                                        # All tests pass
vitest run tests/media-download-workflow.test.ts  # New tests specifically
pnpm typecheck                                   # No type errors
pnpm lint                                        # Clean
```

Then run a real sync with media downloads and confirm the Temporal console no longer shows history size/count warnings (the workflow should `continueAsNew` well before hitting the 10K threshold).

## Feedback

### High

1. **Continue-as-new check is too coarse to reliably prevent hard history-limit termination.**
   - Plan says to evaluate `continueAsNew` only after `processSinglePass()` (`.project/tasks/2026-02-19-add-continueasnew-to-media-download-workflow.md:15`, `.project/tasks/2026-02-19-add-continueasnew-to-media-download-workflow.md:36`).
   - Today, `processSinglePass()` can consume the entire backlog in one invocation (`src/temporal/workflows/media-download/pass.ts:23`), so a single pass can still generate enough events to exceed Temporal limits before the check runs.
   - Recommendation: move the cutover check to batch/item granularity (inside `processSinglePass` loop), or refactor pass semantics to process one bounded chunk per pass and check `workflowInfo()` between chunks.

2. **Drain-and-exit semantics can break across continue-as-new boundaries if break order is wrong.**
   - Existing await-trigger loop relies on post-pass reconciliation to keep draining until remaining reaches zero (`src/temporal/workflows/media-download/loop.ts:47`).
   - The plan’s “check threshold then break after each pass” step (`.project/tasks/2026-02-19-add-continueasnew-to-media-download-workflow.md:36`) can bypass that reconciliation and carry `drainAndExitRequested=true` with `pendingTriggers=0`, causing the next run to exit early in drain mode.
   - Recommendation: preserve current drain reconciliation before deciding to continue-as-new, or explicitly carry a “must-run-next-pass” flag when drain is active and remaining work exists.

### Medium

1. **Internal continuation state is being added to the public workflow input contract.**
   - `_carryForward` is planned directly on `MediaDownloadWorkflowInput` (`.project/tasks/2026-02-19-add-continueasnew-to-media-download-workflow.md:24`), which is also used by CLI and shared command code (`src/commands/shared/media-download.ts:32`).
   - This couples public API surface to internal runtime mechanics and makes misuse/tampering easier.
   - Recommendation: keep `MediaDownloadWorkflowInput` user-facing, and introduce a workflow-internal continuation input type (or validate/ignore caller-supplied `_carryForward` for non-continued runs).

2. **Test plan does not cover the highest-risk signal/carry-forward behavior.**
   - Planned tests cover threshold triggering and counters (`.project/tasks/2026-02-19-add-continueasnew-to-media-download-workflow.md:50`), but not continuity of `pendingTriggers`/`drainAndExitRequested` under continue-as-new.
   - Recommendation: add tests for:
     - continue-as-new during drain mode with remaining > 0
     - trigger signals received mid-pass and carried correctly
     - no continue-as-new once effective limit is fully consumed

3. **History-size guard is not explicitly included, only event-count + server hint.**
   - Plan guards with `continueAsNewSuggested` and `historyLength` (`.project/tasks/2026-02-19-add-continueasnew-to-media-download-workflow.md:15`) but doesn’t mention explicit `historySize`.
   - Recommendation: include a `historySize` fallback threshold where available to reduce risk of size-driven termination on payload-heavy runs.

### Low

1. **Operational docs are not called out for threshold tuning and continuation internals.**
   - Plan does not include updates for operator-facing docs around default threshold behavior, overrides, and expected run-chaining behavior.
   - Recommendation: add a brief docs update (README/ops notes) covering default threshold, when to tune it, and how progress/result counters remain cumulative across continued runs.

## Action Items

### Finding 1 (High): Item-level continueAsNew check inside `processSinglePass`

**Problem**: The plan only checks `continueAsNew` after `processSinglePass()` returns, but a single pass can drain the entire backlog (thousands of items, ~3 history events each), potentially exceeding the hard limit before the check ever runs.

**Resolution**: Add a `shouldContinueAsNew` callback parameter to `processSinglePass` and check it after each individual item download, alongside the existing cancel/pause/limit checks.

**Changes**:

1. **`pass.ts`** — Add `shouldContinueAsNew?: () => boolean` to params. After each item in the inner `for` loop (after the `downloadMedia` try/catch), check the callback. When it fires, set `state.shouldContinueAsNew = true` and return `false` (limit not reached, but work interrupted):

   ```typescript
   // After the try/catch for downloadMedia in the inner for loop:
   if (shouldContinueAsNew?.()) {
     state.shouldContinueAsNew = true;
     return false;
   }
   ```

   Also check it between batches (after the outer `while (state.remaining > 0)` re-enters):

   ```typescript
   // At top of while loop, after waitWhilePaused and isCancelled checks:
   if (shouldContinueAsNew?.()) {
     state.shouldContinueAsNew = true;
     return false;
   }
   ```

2. **`loop.ts`** — Create the callback using `wf.workflowInfo()` and pass it through to `processSinglePass`. After each pass, check `state.shouldContinueAsNew` as an additional break condition:

   ```typescript
   const limitReached = await processSinglePass();
   if (limitReached || state.shouldContinueAsNew) {
     break;
   }
   ```

   The non-`awaitTriggers` path also works — `processSinglePass()` returns, and `index.ts` checks `state.shouldContinueAsNew` after the loop.

**Why item-level**: Each `downloadMedia` activity generates ~3 history events. With the default threshold at 5000 events and batch size 20, checking between batches gives ~60-event granularity. Checking per item gives ~3-event granularity. The overhead is negligible (`workflowInfo()` is a synchronous property read, not an API call).

---

### Finding 2 (High): Drain-mode correctness across continuation boundaries

**Problem**: When `drainAndExitRequested` is true, the loop's post-pass reconciliation at `loop.ts:47` re-checks remaining count and adds a trigger if work remains. Breaking for `continueAsNew` skips this reconciliation. The next run could start with `drainAndExitRequested=true` and `pendingTriggers=0`, causing it to exit immediately at `loop.ts:27` without processing remaining items.

**Resolution**: When initializing state from carry-forward, ensure `pendingTriggers >= 1` if `drainAndExitRequested` is true. This guarantees the next run enters the processing path before hitting the drain-exit check.

**Changes**:

1. **`runtime.ts`** — In `createMediaDownloadRuntimeState`, when initializing from carry-forward:

   ```typescript
   export function createMediaDownloadRuntimeState(
     awaitTriggers: boolean,
     carryForward?: MediaDownloadCarryForward,
   ): MediaDownloadRuntimeState {
     if (carryForward) {
       return {
         downloaded: carryForward.downloaded,
         failed: carryForward.failed,
         skipped: carryForward.skipped,
         remaining: 0, // Will be refreshed by first processSinglePass
         currentMediaKey: undefined,
         lastError: undefined,
         isPaused: false,
         isCancelled: false,
         shouldContinueAsNew: false,
         // Critical: ensure at least 1 trigger when draining so the loop
         // enters processing before hitting the drain-exit check
         pendingTriggers: carryForward.drainAndExitRequested
           ? Math.max(1, carryForward.pendingTriggers)
           : carryForward.pendingTriggers,
         drainAndExitRequested: carryForward.drainAndExitRequested,
       };
     }

     return {
       // ... existing zero-initialized state
     };
   }
   ```

2. **`index.ts`** — When building carry-forward state before `continueAsNew`, include current `pendingTriggers` and `drainAndExitRequested` faithfully:

   ```typescript
   _carryForward: {
     downloaded: state.downloaded,
     failed: state.failed,
     skipped: state.skipped,
     pendingTriggers: state.pendingTriggers,
     drainAndExitRequested: state.drainAndExitRequested,
     startTimeMs: startTime,
   }
   ```

**Why this works**: The `Math.max(1, ...)` in `createMediaDownloadRuntimeState` ensures the drain reconciliation loop in `loop.ts` always gets at least one pass to re-check remaining count. If there's truly no work left, `processSinglePass` returns immediately with `remaining=0`, and the post-pass drain reconciliation at line 47 confirms `remaining === 0` and breaks cleanly.

---

### Finding 3 (Medium): Keep `_carryForward` off the public input type

**Problem**: Adding `_carryForward` directly to `MediaDownloadWorkflowInput` leaks internal continuation mechanics into the type that CLI and command code import.

**Resolution**: Define the workflow-internal input type in `index.ts` as an intersection, keeping the shared type clean. Gate carry-forward acceptance on `workflowInfo().continuedFromExecutionRunId !== undefined` (which is specific to `continueAsNew` chains — unlike `firstExecutionRunId !== runId`, it is not set for retries). Add shape validation on the carry-forward object as a second layer of defense.

**Changes**:

1. **`media-download-types.ts`** — Add `MediaDownloadCarryForward` and `continueAsNewThreshold` (user-facing tuning knob) but NOT `_carryForward`:

   ```typescript
   export interface MediaDownloadCarryForward {
     downloaded: number;
     failed: number;
     skipped: number;
     pendingTriggers: number;
     drainAndExitRequested: boolean;
     startTimeMs: number;
   }

   export interface MediaDownloadWorkflowInput {
     limit?: number;
     batchSize?: number;
     mediaDir?: string;
     awaitTriggers?: boolean;
     /** History-length threshold for triggering continueAsNew. Default: 5000. */
     continueAsNewThreshold?: number;
   }
   ```

2. **`index.ts`** — Define internal extended type locally. Use `continuedFromExecutionRunId` to detect continuation, then validate carry-forward shape:

   ```typescript
   /** Internal input type — includes carry-forward for continuation runs only. */
   type MediaDownloadWorkflowFullInput = MediaDownloadWorkflowInput & {
     _carryForward?: MediaDownloadCarryForward;
   };

   function isValidCarryForward(value: unknown): value is MediaDownloadCarryForward {
     if (typeof value !== 'object' || value === null) return false;
     const cf = value as Record<string, unknown>;
     return (
       typeof cf.downloaded === 'number' &&
       typeof cf.failed === 'number' &&
       typeof cf.skipped === 'number' &&
       typeof cf.pendingTriggers === 'number' &&
       typeof cf.drainAndExitRequested === 'boolean' &&
       typeof cf.startTimeMs === 'number'
     );
   }

   export async function mediaDownloadWorkflow(
     input: MediaDownloadWorkflowFullInput,
   ): Promise<MediaDownloadWorkflowResult> {
     const info = wf.workflowInfo();
     // continuedFromExecutionRunId is set only for continueAsNew chains,
     // not for retries or cron runs
     const isContinuation = info.continuedFromExecutionRunId !== undefined;

     // Accept carry-forward only from genuine continuation + valid shape
     const carryForward =
       isContinuation && isValidCarryForward(input._carryForward)
         ? input._carryForward
         : undefined;
     // ...
   }
   ```

**Why this works**: `MediaDownloadWorkflowInput` stays clean for CLI code. The `MediaDownloadWorkflowFullInput` type lives only in the workflow module, never imported by commands. `continueAsNew<typeof mediaDownloadWorkflow>()` naturally uses the full input type. The dual gate — `continuedFromExecutionRunId` (authoritative SDK signal specific to `continueAsNew`) plus shape validation — ensures carry-forward is only honored in genuine continuation runs, not retries or externally-constructed inputs.

---

### Finding 4 (Medium): Additional test cases for continuation + signal continuity

**Problem**: The planned tests cover threshold triggering and counter initialization but miss the highest-risk signal/carry-forward behaviors.

**Resolution**: Add three additional test cases.

**New tests**:

1. **`continueAsNew during drain mode carries pendingTriggers >= 1`** — Set up drain-and-exit + threshold exceeded mid-pass. Verify the `continueAsNew` call includes `drainAndExitRequested: true` and `pendingTriggers >= 1`.

2. **`trigger signals received before continueAsNew are preserved in carry-forward`** — Fire trigger signals during processing, then trigger continueAsNew. Verify `pendingTriggers` in the carry-forward reflects accumulated (unprocessed) triggers.

3. **`no continueAsNew when effective limit is fully consumed`** — Set carry-forward with `downloaded + failed + skipped` equal to `limit`. Verify the workflow returns normally without calling `continueAsNew`.

4. **`ignores _carryForward on non-continued runs`** — Provide `_carryForward` with non-zero counters but set `continuedFromExecutionRunId: undefined` (fresh run). Verify counters start at zero, not from carry-forward. This validates the `continuedFromExecutionRunId` gate.

5. **`rejects malformed carry-forward on continued runs`** — Set `continuedFromExecutionRunId` to a valid run ID (genuine continuation), but provide a `_carryForward` with missing or wrong-typed fields (e.g., `downloaded: 'not-a-number'`). Verify `isValidCarryForward` rejects it and the workflow initializes with fresh zero counters, falling back safely rather than throwing.

**Mock additions needed**:

```typescript
const mockTemporal = vi.hoisted(() => ({
  // ... existing mocks ...
  workflowInfo: vi.fn(() => ({
    continuedFromExecutionRunId: undefined,
    historyLength: 0,
    historySize: 0,
    continueAsNewSuggested: false,
  })),
  continueAsNew: vi.fn(),
  ContinueAsNew: class ContinueAsNew extends Error {},
}));
```

For continuation tests, override `workflowInfo` to return `continuedFromExecutionRunId: 'prev-run-id'`.
For the non-continuation + carry-forward test, keep the default (`continuedFromExecutionRunId: undefined`).

---

### Finding 5 (Medium): Add `historySize` guard

**Problem**: The plan only guards on `continueAsNewSuggested` and `historyLength`, missing `historySize` which could hit the 50MB hard limit on payload-heavy runs before the event count threshold fires.

**Resolution**: Include `historySize` in the `shouldContinueAsNew` check. The field is available in `@temporalio/workflow` v1.14.1 (`workflowInfo().historySize`, supported on Temporal Server 1.20+, zero on older servers).

**Changes**:

1. **`loop.ts`** — Update the helper:

   ```typescript
   const DEFAULT_CONTINUE_AS_NEW_THRESHOLD = 5000;
   const DEFAULT_HISTORY_SIZE_THRESHOLD = 5 * 1024 * 1024; // 5MB

   function checkContinueAsNew(threshold: number): boolean {
     const info = wf.workflowInfo();
     return (
       info.continueAsNewSuggested ||
       info.historyLength >= threshold ||
       (info.historySize > 0 && info.historySize >= DEFAULT_HISTORY_SIZE_THRESHOLD)
     );
   }
   ```

   The `info.historySize > 0` guard ensures we don't false-positive on older Temporal Servers that always report 0.

2. **Test**: Add a case where `historySize` exceeds threshold while `historyLength` does not, and verify `continueAsNew` is triggered.

---

### Finding 6 (Low): Operator-facing docs

**Problem**: No documentation for threshold tuning and run-chaining behavior.

**Resolution**: Skip standalone docs. Add a JSDoc comment on `continueAsNewThreshold` in the type definition (already shown above) and a brief note in the ADR or CLAUDE.md workflow section when the feature ships. This is sufficient for a tuning knob that has a safe default and rarely needs adjustment. If `continueAsNewThreshold` is later promoted to a user-tunable CLI/config knob, add a short README note at that point.

---

### Revised change summary (file by file)

| File | Changes |
|------|---------|
| `src/temporal/shared/media-download-types.ts` | Add `MediaDownloadCarryForward` interface, add `continueAsNewThreshold?: number` to `MediaDownloadWorkflowInput` |
| `src/temporal/workflows/media-download/runtime.ts` | Add `shouldContinueAsNew: boolean` to `MediaDownloadRuntimeState`, accept `carryForward?` in `createMediaDownloadRuntimeState`, ensure `pendingTriggers >= 1` when draining |
| `src/temporal/workflows/media-download/pass.ts` | Add `shouldContinueAsNew?: () => boolean` callback param, check it per-item and per-batch |
| `src/temporal/workflows/media-download/loop.ts` | Add `checkContinueAsNew` helper (historyLength + historySize + server hint), create callback, pass to `processSinglePass`, check `state.shouldContinueAsNew` after each pass |
| `src/temporal/workflows/media-download/index.ts` | Define `MediaDownloadWorkflowFullInput` locally, validate carry-forward via `continuedFromExecutionRunId` + shape validation, compute `effectiveLimit`, call `wf.continueAsNew()` outside try/catch with re-throw guard, initialize `startTime` from carry-forward |
| `tests/media-download-workflow.test.ts` | Add `workflowInfo`, `continueAsNew`, `ContinueAsNew` to mock. Add tests: threshold trigger, carry-forward init, server hint, effective limit, drain-mode carry-forward, trigger signal preservation, historySize guard |

## Notes

## Implementation Review Findings (2026-02-20)

### Medium

1. **Carry-forward validation is too weak for numeric fields and can still admit malformed continuation state.**
   - Evidence: `isValidCarryForward` only checks `typeof === 'number'` for counters and trigger fields (`src/temporal/workflows/media-download/index.ts:35`), which accepts `NaN`, `Infinity`, and negative values.
   - Impact: malformed payloads can bypass the intended safety gate and poison runtime math (for example `effectiveLimit` at `src/temporal/workflows/media-download/index.ts:62`), potentially causing incorrect limit behavior or invalid activity input values.
   - Recommendation: validate with `Number.isFinite(...)` plus non-negative integer constraints for `downloaded`, `failed`, `skipped`, `pendingTriggers`, and non-negative finite for `startTimeMs`.
   - **Resolution**: Replaced `typeof === 'number'` with `Number.isInteger()` + `>= 0` for counters (`downloaded`, `failed`, `skipped`, `pendingTriggers`) via `isNonNegativeInteger` helper, and `Number.isFinite()` + `> 0` for `startTimeMs`. Added test covering NaN, Infinity, negative, zero-startTimeMs, and fractional values — all correctly rejected with fallback to fresh counters.

2. **`continueAsNewThreshold` is not normalized/validated before use.**
   - Evidence: threshold is used directly from input (`src/temporal/workflows/media-download/index.ts:59`) and passed into comparison logic (`src/temporal/workflows/media-download/loop.ts:12`) without finite/positive guards.
   - Impact: invalid values (e.g. `0`, negative, `NaN`) can cause pathological behavior: immediate continue-as-new loops or silently disabling the history-length guard.
   - Recommendation: normalize once in `index.ts` (finite positive integer, minimum floor) and fall back to `DEFAULT_CONTINUE_AS_NEW_THRESHOLD` when invalid.
   - **Resolution**: Added validation in `index.ts`: `Number.isInteger(rawThreshold) && rawThreshold > 0`, falling back to `DEFAULT_CONTINUE_AS_NEW_THRESHOLD` otherwise. Added test verifying 0, -1, NaN, 1.5, and Infinity all fall back to default.

### Low

1. **Task plan documentation is now internally inconsistent with the implemented design.**
   - Evidence: the original “Changes” section still states `_carryForward` is on `MediaDownloadWorkflowInput` and that continue-as-new checks happen after each full pass (`.project/tasks/2026-02-19-add-continueasnew-to-media-download-workflow.md:24`, `.project/tasks/2026-02-19-add-continueasnew-to-media-download-workflow.md:36`), while implementation moved to internal full-input typing and per-item checks.
   - Impact: future maintainers reading only the top plan can implement follow-ups against stale assumptions.
   - Recommendation: align the top “Changes/Approach” sections with the finalized implementation summary below.
   - **Resolution**: Updated Approach (line 15) to describe per-item checks, historySize guard, and continueAsNew placement outside try/catch. Updated Changes section 1 (line 24) to note `_carryForward` lives on internal type. Updated Changes section 3 (line 34-37) to describe exported `checkContinueAsNew` helper and post-pass `state.shouldContinueAsNew` check.
