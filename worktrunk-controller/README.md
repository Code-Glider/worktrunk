# Worktrunk controller

This fork adds a controller for worktree cleanup analysis and agent throughput. It records durable scans and task evidence, produces read-only reports, and supports selected quarantine, restore and retention purge for worktrees and cache on cooperative Windows hosts. See [PROGRESS.md](PROGRESS.md) for acceptance checks and measured results.

Delivery is on GitHub. The example scheduler is disabled and runs observation only. `apply` and `purge` require an explicit decision ID and opt-in policy. Ignored agent configuration stays protected.

## Development

Use the repository's Rust 1.98 toolchain and Node 24.15.x. The Node controller has no npm dependencies. Its native Windows lifetime helper uses the pinned `win32job` crate; the repository's prohibition on unsafe Rust remains enabled.

```console
node --test --test-timeout=20000 worktrunk-controller/tests/*.test.mjs
cargo test --locked --test integration test_list_controller
cargo test --locked --test integration test_remove_controller
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

Each inventory item has a decision ID, status and reasons. Logical bytes describe checkout content. Physical savings remain unavailable. Ignored or untracked files, hidden index entries, links, nested repositories, user locks, primary or default checkouts, unknown age and protected paths veto eligibility. Assume-unchanged and skip-worktree flags make cleanliness unknown. A failed probe produces `analysis_failed`, keeps the data and makes the CLI exit nonzero.

The report's worktree backlog summarizes the latest saved scan for each scanned project, independently of the throughput window. It counts observed worktrees, eligible and retained items, item analysis failures, and stale registrations. Stale registrations are included in the retained count. A project scan that could not enumerate worktrees shows unavailable counts and the error. JSON includes retention reasons and policy status. Text marks counts from a previous policy.

An enrolled checkout can qualify in a scan when its exact completed attempt and current commit match a recent explicit GitHub acceptance. Refresh the issue after the managed launch ends and the reviewer accepts its commit. Scans use the last successful read and retain the checkout when that read began more than five minutes ago. Reopening, a higher numbered attempt, or a later producer on the checkout can invalidate the evidence. JSON includes the issue observation time and the task and producer reasons.

For checkout eligibility, the registry project must declare `"producerAdmission":"cooperative-windows-job-v1"` before launch. This asserts that all checkout writers use the native admission contract. The scan verifies the same pinned helper used by the completed launch and checks for active or unresolved claims. Older launches without recorded checkout claim history remain available for throughput. `worktreeApplyEnabled` means at least one selected project has the Windows helper, opt-in policy, producer declaration and GitHub issue binding configured. Eligibility remains a preview until the selected executor verifies current evidence.

## Scan/report job example

[scheduling/scan-report.ps1](scheduling/scan-report.ps1) runs `scan`, then `report` for `[today UTC − 7 days, today UTC)` by default. It fixes the window once per invocation, stops on either command's failure and shares a default 900-second wait budget between the commands and output forwarding. It uses the configured registry and artifact allowlist. The job writes scan state and metadata and performs no cleanup.

Add `-SyncGitHubIssues` to refresh tracked issues before scanning. The runner uses GitHub CLI access under the scheduled account and shares its wait budget with the refresh. If the refresh exits unsuccessfully, the runner still scans and reports, then exits nonzero. A launch failure or timeout stops the cycle. The disabled XML example leaves GitHub refresh off.

Use native Windows, PowerShell 7 and Node 24.15.x. Supply absolute Node/config paths and keep the private configuration outside managed roots. The configuration directory must be writable: a persistent, empty `controller.json.scan-report.lock` beside it holds an exclusive handle while participating runners use that same path. Leave the file present. Separate config aliases, direct CLI calls and orphan observers after abrupt runner termination are outside this cooperative lock.

```powershell
& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File 'C:\code\worktrunk\worktrunk-controller\scheduling\scan-report.ps1' -Node 'C:\tools\node.exe' -Config 'C:\private\controller.json' *> 'C:\private\scan-report.log'
```

That explicit log destination is replaced on each manual invocation; keep it outside managed roots. Scan state remains in SQLite, while generated reports go to the caller. Task Scheduler does not preserve stdout: the XML example alone retains scan state, not a report log. Use the existing `report` command to regenerate a report or provide caller-owned capture during deployment qualification.

[scheduling/scan-report-task.example.xml](scheduling/scan-report-task.example.xml) is a **disabled** daily 03:00 local-time example with an interactive user token, least privilege, `IgnoreNew` and a 16-minute scheduler limit. Replace every `REPLACE` path and the user SID, review the working directory/configuration and retain scan-only policy before any future pilot. It requires that user to be logged in. Nothing registers, enables or installs this task, and no scheduled apply job is provided.

The runner bounds its process/output waits and gives direct-process termination at most five additional seconds. At timeout it requests [.NET process-tree termination](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill); this is best effort, and direct-process exit does not prove every descendant ended. Output is forwarded concurrently with bounded waits. These fixtures do not qualify producer containment, unexpected runner death, power loss or a real scheduled host. Scheduling deployment remains deferred.

## Artifact roots

Artifact roots are explicit configuration, including owner, registered projects, a managed-producer declaration and retention. Declare a shared root once with every project that writes it. Roots cannot overlap each other, state, quarantine, controller code or other protected paths. For example:

```json
{"id":"build-cache","path":"C:/agent-cache/project","owner":"your-host-id","projects":["registered-project-id"],"managedOnly":true,"retentionMs":604800000,"classes":[{"path":".","kind":"reproducible_cache"},{"path":"evidence","kind":"evidence"}]}
```

Class paths are literal relative slash paths, not globs. Supported kinds are `reproducible_cache`, `configuration`, `credentials`, `evidence` and `unknown`; omitted paths default to unknown. Cache declarations require the owner's reproducibility guarantee. Protected ancestor rules and known agent configuration/credential names veto cache classification. These name checks are conservative safeguards, not a general secret detector. Ignoring a file or giving it an old modification time grants no disposal permission.

```console
node worktrunk-controller/bin/controller.mjs enroll-artifact --config <absolute-config.json> --artifact build-cache
```

Enrollment records the existing directory's native incarnation in SQLite without writing inside it. Recreated directories, owner/project binding changes and missing enrollment require explicit repair; scans never adopt them. Scans include configured artifacts, ignored files and Git metadata, preserve mixed/unknown roots and report logical bytes.

Artifacts stay report-only unless the owner explicitly adds `"producerAdmission":"cooperative-windows-job-v1"`. This asserts that every writer uses the native Windows managed admission boundary. Eligibility also requires matching enrollment/ownership, a freshly verified helper pin/protocol/incarnation, inactive producers and the shared preservation policy. Unsupported hosts and missing declarations retain content. No deployed launcher is qualified by the fixture tests.

Managed `run` requires matching enrollment for every artifact root declared for its project. It reserves those roots and the checkout atomically, then rechecks every incarnation before acknowledging native launch. Shared-root cleanup conflicts block every declared project's admission. This coordination covers cooperative writers using the configured launcher; external writers remain unqualified.

Reports expose the latest two artifact observations. Growth is the logical-byte difference for the same enrolled incarnation and configuration, with increasing timestamps and both samples in the report window. Missing samples, changed identity/policy and uncertain ordering yield unavailable growth. Shared roots count once across projects.

`artifactPurges` counts completed artifact purge actions in the report window and sums their verified baseline `logicalBytes`. Repeated purges of the same root count as separate actions; a shared action counts once across projects. Interrupted purges contribute no completed count or bytes. Missing/invalid baseline sizes or unsafe totals make bytes unavailable. Completed actions with missing, future or contradictory timestamps appear separately as `unavailableTimeActions` across all retained history; recovery never substitutes quarantine time for an unknown purge date. These are observed contents removed, with no estimate for unrecorded cleanup. Physical savings and `reclaimedBytes` remain unavailable.

## Selected artifact quarantine and recovery

With `policy.allowApply=true`, select one eligible artifact decision from the latest scan. The controller acquires a durable cleanup claim, creates an exclusive same-filesystem quarantine container and rechecks the full decision before moving the enrolled directory into it. Changed content, configuration or identity requires another scan. Quarantine preserves the full directory.

```console
node worktrunk-controller/bin/controller.mjs apply --config <absolute-config.json> --decision <artifact-decision-id> --format json
node worktrunk-controller/bin/controller.mjs reconcile --config <absolute-config.json> --action <action-id> --format json
node worktrunk-controller/bin/controller.mjs restore --config <absolute-config.json> --action <action-id> --format json
```

The result includes an action ID and both paths. Errors after intent creation include the action ID. Reports list current owned action phases and errors independently of their throughput date window. They read journal state without examining or repairing payloads. `applyEnabled` indicates whether configuration and host support artifact apply. Every apply checks fresh eligibility.

Original and quarantine paths remain fenced against cooperative producers until restoration or proven pre-move cancellation. Filesystem moves and reconciliation share a SQLite write lock. If a controller stops, `reconcile` accepts only a matching native incarnation at exactly one location, completes its recorded direction or cancels an operation that provably never moved. It never retries an uncertain rename. Both locations, neither location, replaced parents/containers and a container created without a committed identity remain unresolved with the claim held. Such states require explicit repair; automatic repair is unavailable.

`restore` works after cleanup is disabled or cache policy changes. Keep the same host, state and quarantine location. It refuses an occupied original path and verifies the original parent and quarantine container. If restoration was interrupted, reconcile it before retrying. Verified empty containers remain in quarantine. This recovery covers process interruption and failed journal writes, not power-loss durability of directory renames or hostile filesystem writers.

## Selected cache purge

After the artifact's retention period, review one quarantined action and select its new purge decision:

```console
node worktrunk-controller/bin/controller.mjs scan --config <absolute-config.json> --action <action-id> --format json
node worktrunk-controller/bin/controller.mjs purge --config <absolute-config.json> --decision <purge-decision-id> --format json
```

Purge requires `policy.allowApply=true`, unchanged quarantined contents, matching enrollment/ownership and fresh cooperative producer evidence. Configuration, credentials, evidence, unknown content and conflicting producers veto it. The retention period is the longer of the original and current artifact settings. It starts after the verified quarantine move and requires conservative native uptime and wall-clock evidence; clock jumps, missing evidence and uncertain restart timing retain data. Older actions and moves recovered without a committed sample must be restored and quarantined again before purge.

Purge deletes only cache descendants in the selected payload. It returns the same verified empty directory to the absent original path, preserving enrollment for the next managed producer. It retains branches and empty action containers. Full scans inspect configured original roots; use `scan --action` to inspect a quarantined payload.

An interrupted purge can have deleted some files. Reconcile before proceeding: a verified empty original proves completion; a matching payload stays claimed and is permanently ineligible for another purge on that action. Restore then returns **remaining contents only**, with the interrupted outcome preserved in reports. Both/neither locations, substituted roots or nonempty original outcomes stay unresolved. Reconciliation never resumes deletion.

## Selected worktree cleanup

Select an eligible linked checkout from `scan --project`. Apply reserves the checkout and its repository, refreshes the bound GitHub issue and verifies the exact accepted attempt and commit. It moves the registered checkout into same-filesystem quarantine and applies a controller-owned Git lock. Stable quarantine holds the checkout claim and allows cooperative sibling work. Restore reacquires the repository and returns the original registered checkout even after policy is disabled or the issue reopens.

```console
node worktrunk-controller/bin/controller.mjs apply --config <absolute-config.json> --decision <worktree-decision-id> --format json
node worktrunk-controller/bin/controller.mjs restore --config <absolute-config.json> --action <action-id> --format json
node worktrunk-controller/bin/controller.mjs scan --config <absolute-config.json> --action <action-id> --format json
node worktrunk-controller/bin/controller.mjs purge --config <absolute-config.json> --decision <worktree-purge-decision-id> --format json
```

Use `scan --action` after the longer of the original and current retention periods. If the last GitHub read expired, sync the issue and review again. The worktree purge decision appears in `projects[].decisions`. Purge refreshes GitHub under repository ownership and rechecks the selected decision, original contents, refs, lock identity and clock evidence. A reopening, changed checkout or applicable removal hook prevents deletion. Successful purge removes only the selected checkout and its registration. The branch remains available.

Use `reconcile --action` after an interrupted operation. Missing or inconsistent native and Git evidence keeps ownership held. A verified remover refusal can leave the unlocked payload available for explicit restore. Worktree actions appear with their project in reports and are separate from artifact purge totals. Qualification uses disposable Windows fixtures. A real launcher and deployment still need host-specific qualification.

## Observation boundary

The controller removes inherited Git and Worktrunk overrides, directives and tracing destinations, uses private user/system configuration, disables project display configuration, and bounds child commands and file inventories. It verifies the executable hash before and after invocation. Native Worktrunk uses invocation-private indexes and object storage, skips the shared temporary-index sweep and fallback, suppresses fsmonitor and Git hooks, disables transports/lazy fetch, and refuses configured filters, merge drivers and diff callbacks. Submodule observations are unavailable pending qualification.

Schema 2 carries an optional `observation` field only in the isolated profile. It contains the actual collector's named refs and integration targets. The controller compares that vector with Git before and after collection; it reuses Worktrunk's integration result. A scan is a set of bounded observations, not a filesystem transaction. Later mutation must acquire producer claims and revalidate fresh evidence.

Allowed repository metadata effects include Worktrunk's bounded SHA caches/LRU and existing audit-log permission hardening under `.git/wt`. Refs, real indexes and checkout contents must survive. SQLite records scans and decisions outside managed roots. Successful invocations remove only their own scratch; failed probes retain private scratch for explicit recovery. These leftovers are not yet swept automatically.

The published observation/telemetry slice passed Windows and Linux CI, including documentation sync on Linux. The native lifetime helper has separate Windows fixtures; Linux/WSL producer containment is unavailable. Remaining roadmap gates must be measured before cleanup operations are called qualified.

## Native removal prerequisite

The isolated native profile also constrains the existing foreground remover to one absolute, noncurrent linked checkout with its branch retained. It refuses applicable user/project hooks, force/reap/approval bypasses, project-config overrides, links, hidden index entries and ignored/untracked content. It fully reads and rehashes retained local Git blobs, then compares raw checkout bytes to catch edits hidden by the stat cache. Missing/corrupt blobs and transformed checkouts, including CRLF content that differs from stored blobs, stay retained.

Selected removal skips repository-wide trash and process housekeeping, custom fsmonitor and direct-removal fallback. Its exclusive staging container cannot replace existing trash. Registration/cleanup failures return nonzero and identify retained staging. Teardown results survive later cleanup failures. Failed controller staging is excluded from ordinary trash drains and requires explicit recovery. The controller calls this native remover only after quarantine and fresh authorization, then verifies the recorded outcome before releasing ownership.

## Managed producer admission

`run` is an explicit, noninteractive launch command for cooperative native Windows agents. It requires a registered repository, an exactly enrolled checkout and an optional `nativeHost` configuration pin:

```json
{"nativeHost":{"path":"C:/worktrunk/target/release/wt-controller-host.exe","sha256":"replace-with-helper-sha256","version":1}}
```

Build the helper with `cargo build --locked --release --bin wt-controller-host`. Leave `nativeHost` absent when only scanning or reporting. No agent adapter is installed by this command.

```console
node worktrunk-controller/bin/controller.mjs run --config <absolute-config.json> --project <registry-id> --path <enrolled-checkout> --session <explicit-session-id> --program <absolute-agent-executable> -- <agent-arguments>...
```

The controller durably reserves the checkout before it starts the helper. The helper joins an anonymous Windows Job Object before spawning user code and waits for a committed acknowledgement. It acknowledges completion only when the direct command and every contained descendant have exited. Detached or suspended descendants keep the claim active. Agent stdin is closed; stdout and stderr go to controller stderr so output cannot impersonate the helper protocol. Controller stdout carries the result, and the direct command's exit status is preserved.

Producer and cleanup claims share one serialized namespace. An issue-bound launch requires exclusive producer access to its checkout. Other producers may coexist on shared artifact roots. An overlapping cleanup claim conflicts with any active or unresolved producer. A missing, moved or recreated outstanding root has unknown ancestry and blocks all cleanup acquisition in this state database; an uncertain cleanup root also blocks all producer admission. Reservations, interrupted startup, failed writes and missing completion remain protected across restart. No lease expiry, PID disappearance, observer event or task outcome releases them. This slice provides no automatic claim repair.

This is a cooperative contract, not a sandbox: launch the actual native agent and keep every writer inside its process tree and declared roots. Windows Job Objects do not cover processes dispatched through WMI, services, another existing process, remote hosts or WSL. Such launchers and independent writers are unsupported. Absence of claims does not prove that unmanaged writers are absent; artifact eligibility requires the separate owner opt-in above. Native Windows fixture success does not qualify a real launcher or enable cleanup. See the [Windows lifetime contract](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) for the underlying process boundary.

## Events and throughput

Configure `eventSources` explicitly. Each source has an `id`, immutable `instance`, `role` (`host` or `task`) and a nonempty list of registered `projects`. Task sources supply an `authority` namespace or a GitHub issue binding. A changed source binding needs a new instance. Only task sources can record acceptance.

```json
{"id":"tracker","instance":"tracker-installation-1","role":"task","projects":["registered-project-id"],"authority":"chosen-task-tracker"}
```

Send one normalized version-1 JSON event on stdin. Required fields are `eventId`, `type` and `project`. Use stable IDs for replay; conflicting replays and source sequence collisions fail. Task projection requires `authorityProject` and `taskId`; attempt outcomes also need `attemptId` and consistent `attemptNumber` to measure first-attempt results. Host projection requires `sessionId`. Optional `at` is UTC epoch milliseconds and `sequence` is a positive source-wide integer. Missing evidence remains unavailable. Raw prompts, transcripts and arbitrary fields are rejected.

```console
node worktrunk-controller/bin/controller.mjs ingest --config <absolute-config.json> --source tracker --format json
node worktrunk-controller/bin/controller.mjs report --config <absolute-config.json> --from 2026-11-01 --to 2026-11-06 --format json
```

For GitHub Issues, bind one registered project to a repository and list the numeric GitHub user IDs allowed to record acceptance. Use `gh api repos/OWNER/REPO --jq .id` for the repository ID and `gh api users/LOGIN --jq .id` for each reviewer ID.

```json
{"id":"github","instance":"github-issues-1","role":"task","projects":["registered-project-id"],"github":{"repository":"owner/repo","repositoryId":123,"acceptorIds":[456]}}
```

A configured reviewer posts one line on the issue in the form `/worktrunk accept ATTEMPT FULL_COMMIT_SHA`. `ATTEMPT` is a positive number and `FULL_COMMIT_SHA` is the full 40-character Git commit ID. The controller reads GitHub’s native reopen events. Closing an issue never records acceptance. To accept work after reopening, post a new acceptance comment with the reviewed attempt and commit.

```console
node worktrunk-controller/bin/controller.mjs sync-github-issue --config <absolute-config.json> --source github --issue 123 --format json
node worktrunk-controller/bin/controller.mjs sync-github-issues --config <absolute-config.json> --format json
```

Sync reads the selected issue through the authenticated GitHub CLI and stores normalized observations locally. The report shows the time of the last successful read. If a previously observed acceptance comment is edited or deleted, the next sync excludes it from current status and preserves the historical observation.

The plural command refreshes issues already tracked by managed launches or saved issue numbers for configured sources. To include an issue synced by an older controller without a managed launch, sync it once by number. Each issue commits independently. Failed reads leave their last successful evidence intact, appear in the command result and cause a nonzero exit.

To associate a managed launch with an issue, add `--source github --issue 123 --attempt 1` before the program argument separator. Optionally add `--agent <agent-id>` for throughput attribution. The launcher reads the issue and verifies the enrolled checkout before admitting the job. Each launch for the issue requires a higher attempt number, including after an interrupted launch. When the native job proves its processes have exited, the controller records the checkout's final commit.

The report attributes a first acceptance to an explicitly named agent only when the GitHub issue, attempt and commit match and the acceptance timestamp is at or after verified completion. It measures task duration from the admitted first attempt when that start and the accepted attempt are both observed. Command exit status provides process completion evidence. GitHub coverage and first-attempt rates remain partial. Selected cleanup separately checks current GitHub acceptance and the checkout's preservation evidence.

The report's UTC end date is exclusive and cannot be in the future. Task event types are `task_started`, `attempt_started`, `attempt_accepted`, `attempt_failed`, `attempt_cancelled`, `task_reopened` and `task_revoked`. Host types are `session_started`, `working`, `waiting`, `session_ended` and `association`. Either source may send an independent `checkpoint` with `fromSequence`/`throughSequence` to expose gaps; checkpoints do not occupy an event sequence. Coverage remains partial and unmeasured even when a declared range is complete.

Reports count each task's first observed acceptance once, by Monday UTC week and authority/project/task identity. Cancellations remain in the first-attempt denominator. Median/p95 durations use accepted tasks with known start/end times; missing or inconsistent timing is unavailable. Attribution counts one team task and keeps multiple contributors separate from single-agent counts. Sessions are independent across source instances and session IDs, including when they share a branch. Waiting/working intervals and overlap are observed samples, not process liveness or a utilization estimate. Reclaimed bytes and usage remain unavailable.

`report` requires existing state and opens SQLite read-only; it never initializes a database. Conflicting simultaneous session states without source ordering and known source-sequence gaps across intervals make session durations and overlap unavailable. Sequences belong to the entire source, so known events from another session or project fill their sequence positions. State-only events preserve the last explicit repository/worktree association.

The native marker setter and Claude direct helper optionally record host observations when a launcher supplies all of `WORKTRUNK_OBSERVER_NODE`, `WORKTRUNK_OBSERVER_SCRIPT`, `WORKTRUNK_OBSERVER_CONFIG` (absolute paths), `WORKTRUNK_OBSERVER_SOURCE` and `WORKTRUNK_OBSERVER_PROJECT`. Generic markers also require `WORKTRUNK_OBSERVER_SESSION`; Claude supplies its payload's session ID. The source must have role `host`. Working/waiting markers record their corresponding state; clearing a marker or Claude SessionEnd ends only that session. Claude Stop means waiting. Recording is bounded to two seconds, failure preserves the original marker/hook result, and the raw Claude payload is never forwarded. Installation and launcher wiring are deferred. Observations grant neither managed producer ownership nor cleanup permission.
