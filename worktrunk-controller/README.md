# Worktrunk controller

This fork adds a controller for worktree cleanup analysis and agent throughput. Durable state, worktree scans, normalized event ingestion and read-only reports are implemented. Managed producer admission, quarantine, restore and selected purge are still being built. See [PROGRESS.md](PROGRESS.md) for acceptance checks and measured results.

Delivery is on GitHub. No service, agent integration or cleanup schedule is installed. `apply` and `purge` are unavailable. The controller never treats ignored agent configuration as disposable cache.

## Development

Use the repository's Rust 1.98 toolchain and Node 24.15.x. There are no controller runtime dependencies.

```console
node --test --test-timeout=20000 worktrunk-controller/tests/*.test.mjs
cargo test --locked --test integration test_list_controller
cargo test --locked --test integration integration_tests::claude_hook
cargo test --locked --bin wt commands::list::json_v2::tests
```

The Node interoperability tests build Worktrunk through Cargo and use Cargo's reported executable path. Tests use disposable repositories. The GitHub workflow runs the controller checks on Windows and Linux; a passing fixture does not qualify a real deployment or its agent host.

## Configuration and scan

Copy [config.example.json](config.example.json) to a private location and replace every example path and the executable hash. The project registry uses Project Mission Control's `projects[].id/root` format. Roots may be relative to the registry file. State and quarantine directories must be outside every registered project and separate from each other. The first execution domain is a single native local filesystem; shared native/WSL writers and network filesystems are not qualified.

Build this fork's executable and pin its SHA-256, version and schema in the controller configuration. An upstream executable of the same version lacks the isolated ref-snapshot contract and cannot supply a successful scan. A configured `worktrunk.default-branch` is required; the isolated profile does not infer or persist one or query a remote.

```console
node worktrunk-controller/bin/controller.mjs scan --config <absolute-config.json> --format json
node worktrunk-controller/bin/controller.mjs enroll --config <absolute-config.json> --project <registry-id> --path <absolute-worktree>
```

`enroll` explicitly writes an incarnation marker in that checkout's Git administrative directory and records its native identity in SQLite. Scans never enroll or repair a marker. Recreating a checkout at the same path and HEAD cannot inherit enrollment. Unknown identities and enrollment conflicts retain the checkout.

Each inventory item has a decision ID, status and reasons. Logical bytes describe checkout content; estimated physical savings remain unavailable. Ignored/untracked files, hidden index entries, links, nested repositories, user locks, primary/default checkouts, unknown age and protected paths veto eligibility. Assume-unchanged and skip-worktree flags make cleanliness unknown. Missing task authority and producer admission currently retain every otherwise clean candidate. A failed probe produces `analysis_failed`, keeps the data and makes the CLI exit nonzero.

## Observation boundary

The controller removes inherited Git and Worktrunk overrides, directives and tracing destinations, uses private user/system configuration, disables project display configuration, and bounds child commands and file inventories. It verifies the executable hash before and after invocation. Native Worktrunk uses invocation-private indexes and object storage, skips the shared temporary-index sweep and fallback, suppresses fsmonitor and Git hooks, disables transports/lazy fetch, and refuses configured filters, merge drivers and diff callbacks. Submodule observations are unavailable pending qualification.

Schema 2 carries an optional `observation` field only in the isolated profile. It contains the actual collector's named refs and integration targets. The controller compares that vector with Git before and after collection; it reuses Worktrunk's integration result. A scan is a set of bounded observations, not a filesystem transaction. Later mutation must acquire producer claims and revalidate fresh evidence.

Allowed repository metadata effects include Worktrunk's bounded SHA caches/LRU and existing audit-log permission hardening under `.git/wt`. Refs, real indexes and checkout contents must survive. SQLite records scans and decisions outside managed roots. Successful invocations remove only their own scratch; failed probes retain private scratch for explicit recovery. These leftovers are not yet swept automatically.

Native Windows fixtures currently pass. The full documentation sync is excluded by upstream on Windows; the schema was generated from the binary and schema unit tests pass. Linux CI and the remaining roadmap gates must be measured before their platforms or cleanup operations are called qualified.

## Events and throughput

Configure `eventSources` explicitly. Each source has an `id`, immutable `instance`, `role` (`host` or `task`) and a nonempty list of registered `projects`. Task sources also require an `authority` namespace. A changed source binding needs a new instance. Configuration grants ingestion authority; a host event cannot assert task acceptance. No real task tracker is selected or installed by this implementation.

```json
{"id":"tracker","instance":"tracker-installation-1","role":"task","projects":["registered-project-id"],"authority":"chosen-task-tracker"}
```

Send one normalized version-1 JSON event on stdin. Required fields are `eventId`, `type` and `project`. Use stable IDs for replay; conflicting replays and source sequence collisions fail. Task projection requires `authorityProject` and `taskId`; attempt outcomes also need `attemptId` and consistent `attemptNumber` to measure first-attempt results. Host projection requires `sessionId`. Optional `at` is UTC epoch milliseconds and `sequence` is a positive source-wide integer. Missing evidence remains unavailable. Raw prompts, transcripts and arbitrary fields are rejected.

```console
node worktrunk-controller/bin/controller.mjs ingest --config <absolute-config.json> --source tracker --format json
node worktrunk-controller/bin/controller.mjs report --config <absolute-config.json> --from 2026-11-01 --to 2026-11-06 --format json
```

The report's UTC end date is exclusive and cannot be in the future. Task event types are `task_started`, `attempt_started`, `attempt_accepted`, `attempt_failed`, `attempt_cancelled`, `task_reopened` and `task_revoked`. Host types are `session_started`, `working`, `waiting`, `session_ended` and `association`. Either source may send an independent `checkpoint` with `fromSequence`/`throughSequence` to expose gaps; checkpoints do not occupy an event sequence. Coverage remains partial and unmeasured even when a declared range is complete.

Reports count each task's first observed acceptance once, by Monday UTC week and authority/project/task identity. Cancellations remain in the first-attempt denominator. Median/p95 durations use accepted tasks with known start/end times; missing or inconsistent timing is unavailable. Attribution counts one team task and keeps multiple contributors separate from single-agent counts. Sessions are independent across source instances and session IDs, including when they share a branch. Waiting/working intervals and overlap are observed samples, not process liveness or a utilization estimate. Artifact growth, reclaimed bytes and usage remain unavailable.

`report` requires existing state and opens SQLite read-only; it never initializes a database. Conflicting simultaneous session states without source ordering and known source-sequence gaps across intervals make session durations and overlap unavailable. Sequences belong to the entire source, so known events from another session or project fill their sequence positions. State-only events preserve the last explicit repository/worktree association.

The native marker setter and Claude direct helper optionally record host observations when a launcher supplies all of `WORKTRUNK_OBSERVER_NODE`, `WORKTRUNK_OBSERVER_SCRIPT`, `WORKTRUNK_OBSERVER_CONFIG` (absolute paths), `WORKTRUNK_OBSERVER_SOURCE` and `WORKTRUNK_OBSERVER_PROJECT`. Generic markers also require `WORKTRUNK_OBSERVER_SESSION`; Claude supplies its payload's session ID. The source must have role `host`. Working/waiting markers record their corresponding state; clearing a marker or Claude SessionEnd ends only that session. Claude Stop means waiting. Recording is bounded to two seconds, failure preserves the original marker/hook result, and the raw Claude payload is never forwarded. Installation and launcher wiring are deferred. Observations grant neither managed producer ownership nor cleanup permission.
