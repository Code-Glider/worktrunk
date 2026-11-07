//! Opt-in invocation boundary for the fork's controller. The caller supplies
//! private, per-invocation scratch; failures must never fall back into a repo
//! or sweep another invocation's files. Ordinary Worktrunk remains unchanged.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};

pub const SCRATCH_ENV: &str = "WORKTRUNK_CONTROLLER_SCRATCH";

pub fn active() -> bool {
    std::env::var_os(SCRATCH_ENV).is_some()
}

pub fn scratch_directory() -> anyhow::Result<Option<PathBuf>> {
    let Some(value) = std::env::var_os(SCRATCH_ENV) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() || path.to_string_lossy().starts_with("\\\\") {
        bail!("Controller scratch must be an absolute local directory");
    }
    require_local_directory(&path).context("Invalid controller scratch directory")?;
    Ok(Some(path))
}

pub fn require_local_directory(path: &Path) -> anyhow::Result<()> {
    if !path.is_absolute() || path.to_string_lossy().starts_with("\\\\") {
        bail!("Controller path must be an absolute local directory");
    }
    for ancestor in path.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor)
            .context("Failed to inspect controller directory")?;
        if !metadata.file_type().is_dir() {
            bail!("Controller path must not traverse links or non-directories");
        }
    }
    Ok(())
}

pub fn require_callback_free(path: &Path) -> anyhow::Result<()> {
    if !active() {
        return Ok(());
    }
    if path.join(".gitmodules").try_exists()? {
        bail!("Controller observation of submodules is not qualified");
    }
    let output = crate::shell_exec::Cmd::new("git")
        .current_dir(path)
        .scrub_git_discovery_env()
        .args(["config", "--null", "--get-regexp",
            r"^(filter\..*\.(clean|process)|merge\..*\.driver|diff\..*\.(command|textconv)|diff\.external)$"])
        .run()?;
    match output.status.code() {
        Some(1) => Ok(()),
        Some(0) => bail!("Controller observation refuses configured Git callbacks"),
        _ => bail!("Failed to qualify controller Git callback configuration"),
    }
}
