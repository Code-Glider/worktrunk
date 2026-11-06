# Fork implementation progress

Fork: https://github.com/Code-Glider/worktrunk
Upstream: https://github.com/max-sixty/worktrunk
Roadmap: [AUTOMATION_PLAN.md](AUTOMATION_PLAN.md)

The reviewed analysis used bac7f7e137cf2814098f2e3e60909f2c4859fc9c. Implementation starts from fork main d022f7683, retaining 18 newer upstream commits, including forced-removal backups. Historical observations are not qualification of this baseline.

## First slice: nested-worktree preservation

1. Fork and branch from current main. Check: origin points to Code-Glider/worktrunk, upstream remains max-sixty/worktrunk. Completed.
2. Add regression cases for ordinary remove, prune preview/live, and a nested child created by a pre-remove hook. Completed: all seven cases failed against unchanged production code for the expected preservation/preview failures.
3. Extend the existing topology guard at planning and after hooks, outside staging/teardown locks. Completed: seven regressions pass on Rust 1.98, including a child path with Hebrew and a space; the three surrounding suites pass with a controlled temporary root.
4. Review and publish this slice. Check: reviewed diff, clean formatting, branch visible on the fork. Fresh-context review approved; its optional live-prune assertion improvement was applied. Publication is tracked by the pull request containing this record.

The controller, durable store/incarnation choice, real agent and outcome adapters, artifact quarantine, isolated invocation contract, and scheduler remain pending. Automatic cleanup stays disabled. This slice does not qualify all platforms or close every roadmap acceptance check.

## Validation

- `cargo +1.98.0 test --locked --test integration test_remove_preserves_nested_worktree -- --nocapture`: baseline 0 passed / 7 failed; fixed 7 passed / 0 failed.
- `cargo +1.98.0 fmt --all -- --check` and `git diff --check`: passed.
- The first wider Windows run used the default temporary root, which contains a space and Hebrew. Removal: 156 passed, 6 failed, 4 already ignored. Prune: 54 passed, 1 failed. Merge source: 22 passed, 1 failed. Failures include unquoted hook paths and platform-dependent path snapshots. No snapshots were accepted or tests weakened.
- With `TEMP` and `TMP` set to an ASCII temporary root for the test invocation, `cargo +1.98.0 test --locked --test integration <filter> -- --nocapture` passed for `integration_tests::remove::` (162 passed, 4 ignored), `integration_tests::step_prune::` (55 passed), and `integration_tests::merge_source::` (23 passed): 240 passed, 0 failed. Unicode child paths remain covered by the new regressions.
- The full project pre-merge gate, all-features suite, and Unix/platform-specific concurrency qualification were not run. This is targeted Windows qualification.

Preservation has execution-level proof for the seven regression cases. This guard covers nested worktrees registered in the same repository; foreign repositories and unregistered directories need the controller's later inventory/preservation policy. Independent writers can still introduce changes after a check. The controller's managed admission and other automatic-cleanup gates remain necessary.
