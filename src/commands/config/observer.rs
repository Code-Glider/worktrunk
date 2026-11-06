//! Optional host telemetry, with explicit launcher-supplied source/session IDs.
//! It cannot grant task authority or producer admission. Recording failure must
//! preserve the marker/hook result; the child is bounded and receives no raw payload.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use worktrunk::shell_exec::Cmd;

pub(super) fn observe_marker(marker: Option<&str>, session: Option<&str>) {
    if worktrunk::controller::active() {
        return;
    }
    let kind = match marker {
        Some("🤖") => "working",
        Some("💬") => "waiting",
        None => "session_ended",
        _ => return,
    };
    let read = |key| std::env::var(key).ok().filter(|value| !value.is_empty());
    let Some(node) = read("WORKTRUNK_OBSERVER_NODE") else {
        return;
    };
    let Some(script) = read("WORKTRUNK_OBSERVER_SCRIPT") else {
        return;
    };
    let Some(config) = read("WORKTRUNK_OBSERVER_CONFIG") else {
        return;
    };
    let Some(source) = read("WORKTRUNK_OBSERVER_SOURCE") else {
        return;
    };
    let Some(project) = read("WORKTRUNK_OBSERVER_PROJECT") else {
        return;
    };
    let Some(session) = session
        .map(str::to_owned)
        .or_else(|| read("WORKTRUNK_OBSERVER_SESSION"))
    else {
        return;
    };
    if ![&node, &script, &config]
        .iter()
        .all(|path| Path::new(path).is_absolute())
    {
        return;
    }
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return;
    };
    let payload = serde_json::json!({
        "version": 1,
        "eventId": format!("{:032x}", fastrand::u128(..)),
        "type": kind,
        "project": project,
        "sessionId": session,
        "at": now.as_millis() as u64,
    });
    let _ = Cmd::new(node)
        .args([
            script.as_str(),
            "ingest",
            "--config",
            &config,
            "--source",
            &source,
            "--format",
            "json",
        ])
        .stdin_bytes(payload.to_string().into_bytes())
        .sensitive_output()
        .timeout(Duration::from_secs(2))
        .run();
}
