# Worktrunk controller

This fork adds a scan-only controller for worktree cleanup and agent throughput. The durable state and worktree analyzer are implemented. Event adapters, throughput reports, managed producer admission, quarantine, restore and selected purge are still being built. See [PROGRESS.md](PROGRESS.md) for acceptance checks and measured results.

Delivery is on GitHub. No service, agent integration or cleanup schedule is installed. `apply` and `purge` are unavailable. The controller never treats ignored agent configuration as disposable cache.

## Development

Use the repository's Rust 1.98 toolchain and Node 24.15.x. There are no controller runtime dependencies.

```console
node --test --test-timeout=20000 worktrunk-controller/tests/*.test.mjs
cargo test --locked --test integration test_list_controller
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
