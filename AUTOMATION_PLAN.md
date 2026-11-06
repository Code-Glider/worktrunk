# Worktrunk automation implementation plan

Status: reviewed roadmap, implementation started 6 November 2026. See IMPLEMENTATION.md for completed checks and remaining gates.

Build an automated worktree and artifact controller that explains cleanup decisions, preserves unfinished work, and measures agent throughput from recorded task outcomes. Keep Worktrunk's integration detection and final removal checks. Start with observation and telemetry; enable deletion only after the preservation and recovery checks pass.

Use a small local CLI in `worktrunk-controller/`, Node ES modules, and the built-in test runner. Invoke pinned Worktrunk in fresh subprocesses: its library API is unstable and caches assume a command invocation. Every deletion needs an owner, a policy, current safety evidence, and a recorded outcome. Report incomplete observations as unknown. These are proposed defaults.

Keep these responsibilities separate without introducing a framework:

| Responsibility | Owns | Must not own |
| --- | --- | --- |
| Observation/adapters | Worktrunk/Git facts and normalized host events | Cleanup eligibility or task acceptance invented from markers |
| Policy | One pure decision function over facts, target kind, and policy version | Git calls, filesystem writes, or a second merge detector |
| Local state | Versioned events, identities, claims, action intents, quarantine manifests | A separate persistence mechanism for each feature |
| Executor | Claims, fresh observation, the shared policy, native mutations, reconciliation | A second set of eligibility rules |
| Reports | Read-only projections of facts and recorded outcomes | Starting work or cleanup |

These are logical boundaries; split files when the implementation needs them. Use the same policy for scan, apply, and purge. Worktrunk remains the owner of Git integration detection and final removal checks. Add each host adapter as an ordinary module against the normalized event contract; no plugin loader, event bus, or public SDK is needed.

The checked source is `worktrunk` at `bac7f7e137cf2814098f2e3e60909f2c4859fc9c`. The important starting points are:

| Area | Existing code to reuse or change |
| --- | --- |
| Prune decisions | `worktrunk/src/commands/step/prune.rs`, especially `check_one` and `render_dry_run`; `src/commands/repository_ext.rs` |
| Removal safety | `worktrunk/src/git/remove.rs`; `src/output/handlers.rs`; `src/commands/worktree/finish.rs` |
| Structured observations | `worktrunk/src/commands/list/json_v2.rs`; `src/commands/list/collect/mod.rs`; `src/git/repository/integration.rs` |
| Activity adapters | `worktrunk/src/commands/config/state.rs`; `src/commands/config/plugins.rs`; `plugins/worktrunk/`; `dev/opencode-plugin.ts` |
| Artifact handling | `worktrunk/src/git/repository/working_tree.rs`; `src/copy.rs`; `src/remove_dir.rs`; `src/git/reap.rs`; `src/commands/step/tether.rs` |
| Diagnostic logs | `worktrunk/src/command_log.rs`; `src/log_files.rs`. These are supplementary input, not a complete task ledger. |
| Existing project inventory | `stonfreetall/gitea-drive/apps/project-mission-control/scripts/lib/registry.mjs` and `paths.mjs`. Read existing project roots and reuse path-validation conventions; do not change diagram artifacts. |
| Regression fixtures | `worktrunk/tests/integration_tests/step_prune.rs`, `remove.rs`, `claude_hook.rs`, `config_state.rs`, and relevant existing unit tests |

Measured baseline from the completed local analysis:

- Nonignored untracked files block prune. Moving the same file into ignored `.archon/` makes the worktree removable and the file is deleted with it.
- A clean integrated parent containing an ignored nested worktree was removed even though the child had an unmerged commit and an untracked file. The child branch survived; its untracked file did not. The nested guard currently applies to merge cleanup, not ordinary remove or prune.
- A cold prune preview persisted default-branch configuration. A squash-merge preview added two loose Git objects and four cache files while preserving refs and directories. Do not describe the existing preview as write-free.
- The Windows prune selection passed 54 tests and failed one test with an unquoted temporary path containing spaces. That test passed when repeated under a path without spaces. All six Claude-hook tests passed. These runs used installed Rust 1.97.1 with the declared 1.98 requirement overridden; they are not supported-toolchain qualification.

The historical probe artifacts remain in the analysis workspace. Reproduce essential fixtures in this fork before relying on those observations.

1. **Set the implementation boundary and reproduce the measured hazards.**

   Identify the first deployment host/execution domain, actual agent launcher, task-outcome authority, pinned Worktrunk executable, supported Node version, project registry, and state directory outside cleanup roots. A terminal-spawn result proves neither agent startup nor task completion. Reuse Project Mission Control's registry format, with boundary validation. Choose one local persistence/serialization primitive and incarnation mechanism using two-process, interrupted-write, and same-path recreation probes. Support one host and local filesystem first; concurrent native-Windows/WSL or network-filesystem writers require separate qualification. Define one versioned configuration with explicit roots and scan-only defaults. Without a task authority, outcome metrics are unavailable and apply stays disabled.

   Add hermetic fixtures for ignored nested worktrees, ordinary untracked versus ignored files, and preview writes. Use the repository's `TestRepo` and command helpers rather than a hard-coded binary path. Assert the nested child's branch, untracked content, and registration before and after the attempted removal. Cover a path containing spaces and Unicode. Establish the baseline with the declared Rust 1.98 toolchain on the first deployment platform; qualify another platform before deploying there. Separate environment failures from product failures.

   Acceptance check: the new nested-preservation assertion fails against the pinned implementation for the observed reason; the contrasting untracked/ignored fixture passes and documents current behavior. Save the exact commands and outputs. Use `cargo test --test integration step_prune:: -- --nocapture` for the existing prune selection; do not accept new snapshots automatically. A fresh configured checkout can resolve one disposable registered project; unsupported executable/schema versions and incomplete configuration fail clearly before apply becomes available.

2. **Protect nested worktrees on every relevant removal path.**

   Extend the existing nested-worktree protection to ordinary removal and prune. Check topology during planning and again after approved pre-remove hooks. Preserve lock ordering and parallel prune staging; the source explicitly warns against putting a blocking live-registry read directly into `stage_worktree_removal`. Retain the existing ownership, dirty-file, fsmonitor, fresh-ref, and compare-and-swap checks.

   Check callers in `src/git/remove.rs`, `src/output/handlers.rs`, and `src/commands/step/prune.rs`. Keep the public CLI unchanged for this fix.

   Acceptance check: the nested regression now preserves the child and its untracked file through both ordinary remove and prune, including a child introduced by a pre-remove hook. Existing merge, concurrent-prune, cancellation, and branch-race tests pass on supported platforms without a hang. A candidate with uncertain topology is retained.

3. **Build the controller's observation and decision report.**

   Introduce the single local persistence boundary selected in step 1 before storing observations or enrollment. Serialize cross-process writes from finite CLI invocations; reuse it for identities/decisions, events, and later claims, manifests, and actions. Define commit/acknowledgment and replay behavior once. No daemon or second journal is needed. Version and validate records/configuration; reject unsupported versions. Implement migration only for an actual version change, with a recoverable backup. Corruption, failed durable writes, or disk-full blocks mutation and preserves damaged evidence.

   Read explicitly registered projects and use Worktrunk's schema-2 list output plus Git plumbing for missing facts. Assign controller repository/worktree IDs, but require enrollment/incarnation evidence before treating a target as managed. Common-Git-directory and worktree Git-directory addresses, branch, and HEAD alone cannot prove continuity after deletion/recreation. Select the host-supported incarnation mechanism in step 1 and record its metadata-write footprint. Missing or ambiguous evidence invalidates old decisions and task associations. Record canonical path, branch and target SHAs, observation time, working-tree state, nested repositories/worktrees, and data visibility. Paths and branch names are mutable attributes. A verified controller relocation preserves the incarnation. Inventory ignored files and tracked files hidden by assume-unchanged or skip-worktree flags. Never infer clean or integrated from missing, null, timed-out, or failed observations.

   Persist one immutable decision input: target kind/incarnation, named candidate/default/upstream ref vector including absent refs and target mapping, relevant session/task revisions, content/ownership evidence, and policy/configuration generation. Bind Worktrunk's integration result to that same ref vector. Schema 2 currently exposes the reason without its target SHAs. Reject inconsistent capture; if the wrapper cannot establish that binding, add a minimal structured snapshot field from Worktrunk's existing ref snapshot rather than reproduce its detector. Freshness compares safety inputs, excluding display fields and observation timestamps.

   Validate external data once at the boundary. Invoke children with argument arrays and explicit cwd; scrub inherited Git discovery variables and disable optional index writes for observation. Pin the collection/configuration profile and bound probes; a timeout yields unknown. Interpret schema-2 absence with its `collected` envelope rather than treating every omitted field as a known negative.

   Qualify an isolated Worktrunk invocation contract before calling observation safe. Some dirty-tree observations create a temporary index; current construction sweeps age-matching indexes in system temp, with a Git-directory fallback. Controller invocations must use their own scratch scope and must not sweep unrelated indexes or fall back into shared scratch on failure. Add the smallest internal opt-in behavior needed; preserve ordinary interactive defaults. This is the same isolation boundary later used for removal, not a second Git implementation.

   Include native Git callbacks in that boundary. Enforce `core.fsmonitor=false` throughout controller observation and removal, while retaining the full final cleanliness check; reuse the existing `ensure_clean_without_fsmonitor` path. A custom monitor can create ignored data during status after the controller's inventory. Other callback-producing probes must be qualified under the fixed invocation profile or reported unavailable; a Worktrunk hook veto alone does not constrain Git callbacks.

   Return `eligible`, `retain` with reason codes, or `analysis_failed` for every inventory item. Protect the primary checkout, default/unborn branches, user locks, controller code/state/current directory, and unknown age or ownership. Add safety evidence before ranking eligible items by reclaimable space and rebuild cost. Record logical bytes separately from estimated physical savings; do not double-count the shared Git object store. Treat unregistered directories as unknown until explicitly adopted. Do not call prune preview as a zero-write scanner: document allowed metadata/cache writes and verify that refs, real indexes, and worktree contents remain unchanged.

   Implementation boundary: controller CLI, observation, pure policy, and their tests. Reuse existing Worktrunk observations before adding any new CLI interface. If an internal decision refactor is necessary, preserve typed retention and Git failures instead of converting them to `.ok()`.

   Acceptance check: mixed-state fixtures explain every item and retain unsafe/unknown cases. Same-path/same-HEAD recreation cannot inherit decisions/tasks; verified moves preserve identity. Observation changes no refs, real indexes, or worktree files; enrollment is a separate mutation. An outside-scope aged scratch sentinel survives allocation failure. A configured custom fsmonitor that would write an ignored sentinel is never invoked. Use `node --test worktrunk-controller/tests/*.test.mjs` once tests exist.

4. **Record sessions and task attempts with durable identity.**

   Use the shared state for one event-ingestion entry point. Record event ID, source, observed time, available source time/sequence, repository/worktree identity, agent, session, task, attempt, HEAD, and event type. Do not manufacture an ID association when the host supplies none. Deduplicate replayed events. Persist only normalized fields needed for analysis, not prompts, credentials, file contents, or raw command bodies.

   Keep identity domains separate. Deduplicate source events by `(source instance, event ID)`. Key tasks by `(outcome authority, authority project, task ID)`, attempts by `(task key, authority attempt ID)`, and sessions by `(host instance, session ID)`. Worktree associations may change without changing those keys. Reused local IDs in other projects remain distinct. Missing stable IDs or attribution remain partial evidence, rather than guessed joins or deduplicated authoritative outcomes.

   Connect the actual configured agent host first, then add adapters using the same contract. Instrument both the generic marker setter and Claude's direct helper if those paths are used. Keep adapter-specific semantics: Stop means waiting, SessionEnd ends a session, and only the task authority can report task acceptance. Track independent sessions on the same branch. An expired lease or missing end event becomes unknown; it does not prove abandonment.

   Observer recording failures preserve host-hook behavior. Without an independent source sequence/checkpoint or expected-event denominator, even a silent loss is undetectable: coverage remains partial/unmeasured, never an assumed percentage. Available upstream gaps are recorded explicitly. Observers cannot authorize deletion. Managed admission belongs to step 6; the analyzer and throughput milestone must work without it.

   Implementation boundary: shared local state, normalized events/session projections, one actual host adapter, and tests; existing plugin files only where required. Read the factory/task source before choosing its outcome adapter. Project Mission Control's inspected registry and status summaries do not establish task acceptance.

   Acceptance check: replay two sessions on one branch, moved/detached worktrees, duplicate/out-of-order events, missing session-end, and restart. Ending one session preserves the other. Two CLI producers cannot lose acknowledged events. Inject interrupted writes, unsupported schemas, disk-full, and a silently dropped observer event: coverage is partial/unmeasured unless independent source evidence detects the loss. Hooks preserve host behavior. No executor or managed launcher is needed for this milestone.

5. **Compute worktree backlog and agent throughput from recorded evidence.**

   Report cleanup backlog, retention reasons, stale registrations, owned artifact growth, and reclaimed bytes. Before artifact enrollment, growth is unavailable rather than inferred from arbitrary temp directories. Report distinct tasks first accepted in each UTC calendar week, counting each authoritative task once across retries, moves, and duplicate acceptance events. Reopened/revoked outcomes appear separately and invalidate any affected cleanup evidence. Attribute acceptance once from authoritative accepted-attempt evidence; show ambiguous/multi-agent contributions separately without duplicating team totals.

   Define first-attempt acceptance rate over tasks whose first attempt has an authoritative terminal outcome in the window: first-attempt acceptances divided by all such first-attempt outcomes, including cancellations; also show cancellation counts separately. Show unresolved attempts/open age alongside it. Report attempts/retries per task and median/p95 task-start-to-first-acceptance duration for the accepted-task cohort, with sample counts and source coverage. Working/waiting time needs observed transitions; overlap is session time/concurrency, not one worktree duration. Missing intervals, invalid clock ordering, attribution, or usage yield unavailable metrics, never fabricated zeros or cost estimates.

   Implementation boundary: report projections and tests, with text and JSON through the controller CLI. Historical Worktrunk logs may supply labeled partial evidence; they cannot reconstruct missing task outcomes.

   Acceptance check: a fixed timeline covers reused local IDs across projects, moved retries, multiple agents, duplicate acceptance, reopened tasks, waiting/overlap, and incomplete attempts. Assert exact cohorts, counts, durations, attribution, and coverage; duplicate replay changes no totals. Missing authority/IDs/timestamps produce explicit unavailable metrics. Team acceptance totals never double-count contributors.

6. **Gate and quarantine managed worktrees and artifacts.**

   Register controller/agent-owned artifact roots and classify files as reproducible cache, configuration/credentials, retained evidence, or unknown. An ignore rule or old modification time never establishes disposability. Copying can preserve old mtimes. Start with artifacts created by the controller or an integrated agent; third-party temporary paths remain report-only until explicitly adopted. Artifact targets have their own owner/root incarnation and admission claim; an idle worktree does not authorize deleting a root shared by another session or checkout. Roots without exclusive producer coordination remain report-only.

   The shared policy permits first-release artifact purge only for reproducible cache covered by an explicit owner/retention policy. Configuration/credentials, retained evidence, and unknown content stay retained regardless of generic TTL. A mixed root inherits every protected descendant's veto. Whole-worktree cleanup applies the same rule to ignored/untracked descendants; integration proves nothing about those files. Clean tracked content must remain independently recoverable through retained reachable Git history. Supporting disposal of other classes later needs a separate explicit policy/preservation decision, never silent reclassification as cache.

   Implement managed admission before any quarantine mutation: reserve worktree and declared artifact roots durably before the actual agent starts, and refuse admission while a conflicting cleanup claim exists. Put the guard in the actual execution environment, including WSL when used, rather than around an outer terminal spawn. Failed state writes prevent managed launch. Unknown/external sessions stay outside automatic apply; a controller lock does not exclude independent Git/filesystem writers.

   Model reservation, starting, running, ended, and unresolved owner states in shared state. Bind ownership to a unique launch token and host-supported process/lifetime evidence, never PID alone. Acquire all required producer claims together; ancestor/descendant roots conflict with cleanup too. Reservations and cleanup claims survive controller failure. Missing startup acknowledgment does not prove no child started; expiry, PID reuse, and launcher death do not authorize reclaim. Reconcile against supported owner evidence or require explicit repair while retaining the data. Known producers may coexist; cleanup requires every relevant producer to have ended. Quarantined targets refuse new admission until restored.

   Move eligible owned artifacts into a controller quarantine on the same filesystem. Store the original path, incarnation, owner, reason, and expiry as an action manifest in the shared local state. Keep this separate from Worktrunk's immediately drained trash. Do not raw-rename registered worktrees. For whole linked-worktree quarantine, use Git's worktree move mechanism to preserve registration, retain the branch, and apply a controller-owned lock. Reconcile crashes between intent, move, and lock steps. Reject unsupported moves, occupied destinations, cross-device fallbacks, nested checkouts, and unresolved path identities rather than copy-and-delete. Retention durations must be explicit configuration before purge is enabled.

   Implementation boundary: managed admission, artifact observations, native quarantine/restore using shared policy/state, and their tests. Resolve actual paths and reject symlink/junction traversal at destructive boundaries; the existing lexical path helper alone is insufficient. Do not repurpose `.git/wt/trash` as durable storage.

   Acceptance check: race launch against quarantine; conflicting claims cannot succeed. Crash before spawn, after spawn but before acknowledgment, after acknowledgment, and during cleanup; restart/PID reuse and suspension cannot free a live claim. Round trips preserve sentinel contents, HEAD, and registration; restore refuses occupied paths. Mixed roots and ignored worktree descendants retain configuration, unique evidence, and unknown files after expiry; only explicitly eligible cache purges. Shared/overlapping roots, symlink/junction escapes, and cross-device moves stay protected. Restore needs no task acceptance.

7. **Execute selected cleanup with revalidation and a durable action journal.**

   Add explicit apply and purge operations that consume selected decision IDs, not global prune. Worktree targets require a repository lock and worktree claim, plus fresh identity, branch/target SHAs, integration, task outcome, topology, dirty/ignored content, and preservation evidence. Artifact targets require their owner/root claim and fresh identity, ownership, producer inactivity, containment, contents, and retention evidence; Git predicates do not apply. Both call the same target-kind policy used by scan. Changed or incomplete evidence requires a new decision. Process discovery is supplementary and must expose visibility failures. Do not break user locks, force-remove, auto-commit, kill arbitrary processes, or approve hooks with `--yes`.

   Quarantine first. Expiry only makes an item due for review: acquire the claim and repeat the shared policy against fresh evidence, including the ref vector, policy generation, and class dispositions. Uncertain elapsed retention after clock jumps/restart stays retained. Unlock only a verified controller-owned quarantine lock. Journal durable intent before mutation; failed writes cause no action. Reconcile uncertain outcomes before retrying. Preserve actual branch fate, partial success, cancellation, and errors. Keep branches by default; deletion requires explicit policy and Worktrunk's fresh integration/CAS checks. Orphan branches/stale registrations remain explained inventory until their explicit policies exist.

   Extend the isolated invocation contract to Worktrunk's existing foreground remover: omit repository-wide internal sweeping and reject applicable removal hooks inside the frozen execution plan before mutation. Plain `wt remove --foreground` starts a detached drain of unrelated trash and orphan-fsmonitor housekeeping. A wrapper precheck fences neither those effects nor changed hook selection. Preserve the selected target's final safety gates; do not build another remover. Until the pinned executable supports this contract, whole-worktree purge is unavailable with a stated reason. Normal interactive behavior stays unchanged; changed structured/invocation interfaces require existing schema/help tests.

   For the first release, retain whole worktrees with any applicable removal hooks, including post-remove and conditional post-switch hooks. Pre-remove hooks can create ignored content after the wrapper check; post hooks can mutate state asynchronously after foreground removal returns. A wrapper precheck closes neither gap. Later support needs both a final internal preservation guard and explicit admission/completion for asynchronous hooks. Preserve approvals and never silently disable hooks. Automatic apply is limited to controlled targets with cooperative producer admission; uncertainty vetoes it.

   Implementation boundary: executor/CLI dispatch and integration tests. Reuse managed admission, shared state/policy, and existing Worktrunk removal rather than rebuilding them.

   Acceptance check: for both target kinds, only the selected target changes; unrelated trash/process sentinels survive isolated mode and custom fsmonitor never executes. Normal Worktrunk behavior keeps its tests. Upstream-only changes with the same integration reason, policy changes, protected artifact classes, clock uncertainty, content/owner/topology changes, admission races, and removal hooks veto apply/purge. Failed intents cause no mutation; recovery reconciles outcomes without repeating completed removal. Partial failures retain outcomes and fail the batch.

8. **Qualify the controller and enable scheduling in stages.**

   Add a finite scan/report job before any scheduled apply job. Use an explicit project registry and artifact-root allowlist; keep factory-managed worktrees under their existing creation and outcome authority. Choose the native scheduler for the actual deployment host: Windows Task Scheduler on this workstation, or a systemd user timer after Linux qualification. Prevent overlapping runs and bound scan cost. Store controller state outside managed cleanup roots. Scheduling apply remains disabled until its configured policies and recovery checks pass.

   Proposed files: controller README, example policy, and one scheduler definition for the first deployment host. Add other schedulers only when there is a deployment to support.

   Acceptance check: two scan cycles and a restarted controller give consistent explanations without applying cleanup. A scheduled disposable pilot proves session collection, task metrics, quarantine, restore, expiry, targeted removal, and journal recovery end to end. Existing Worktrunk checks pass for changed code; any modified CLI help/manifests also pass their existing sync/layout tests. Record platform coverage and remaining failures before enabling a real apply schedule.

Steps 1-2 form the safety fix. Steps 3-5 produce the first useful analyzer and throughput report with apply disabled. Steps 6-8 enable bounded automation and recovery. Independent telemetry work can proceed while the core safety fix is reviewed, but apply depends on all earlier preservation checks.

Before purge, explicitly configure retention durations and managed artifact roots. Whole-machine cleanup, remote-branch deletion, cost estimation, all-agent coverage, automatic cleanup with removal hooks, distributed coordination, a database service, dashboard, and general temp sweeper are outside the first release.

Plan review completed: three sequential red-team rounds with revisions, followed by a fourth closing check, approved the plan against SoC, DRY, YAGNI, KISS, extensibility, and reliability. Thirteen findings were resolved in the local review record. Implementation progress and evidence are recorded in IMPLEMENTATION.md. All implementation checks above remain future acceptance criteria, not claims of passing work.
