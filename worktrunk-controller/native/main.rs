use std::io::BufRead;
#[cfg(windows)]
use std::io::Write;

#[cfg(windows)]
use anyhow::Context;
use anyhow::bail;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Launch {
    version: u32,
    token: String,
    cwd: std::path::PathBuf,
    program: std::path::PathBuf,
    args: Vec<String>,
}

#[cfg(windows)]
fn send(value: serde_json::Value) -> anyhow::Result<()> {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{value}")?;
    out.flush()?;
    Ok(())
}

fn line(input: &mut impl BufRead) -> anyhow::Result<String> {
    let mut bytes = Vec::new();
    std::io::Read::take(input, 65537).read_until(b'\n', &mut bytes)?;
    if bytes.len() > 65536 || bytes.last() != Some(&b'\n') {
        bail!("Missing or oversized host protocol line");
    }
    Ok(String::from_utf8(bytes)?)
}

fn run() -> anyhow::Result<()> {
    if std::env::args().skip(1).collect::<Vec<_>>() == ["--version"] {
        println!("wt-controller-host 1");
        return Ok(());
    }
    if std::env::args().len() != 1 {
        bail!("Host accepts a version-1 launch protocol on stdin");
    }
    let mut input = std::io::stdin().lock();
    let launch: Launch = serde_json::from_str(&line(&mut input)?)?;
    if launch.version != 1
        || launch.token.len() != 36
        || !launch
            .token
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-')
        || !launch.cwd.is_absolute()
        || !launch.program.is_absolute()
        || launch.args.iter().any(|arg| arg.contains('\0'))
    {
        bail!("Invalid native launch protocol");
    }
    contained_launch(launch, &mut input)
}

#[cfg(not(windows))]
fn contained_launch(_launch: Launch, _input: &mut impl BufRead) -> anyhow::Result<()> {
    bail!("Managed lifetime containment is not qualified on this native host")
}

#[cfg(windows)]
fn contained_launch(launch: Launch, input: &mut impl BufRead) -> anyhow::Result<()> {
    use std::os::windows::io::AsHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use win32job::{ExtendedLimitInfo, Job};

    // Join before any user code; no breakaway flag is enabled.
    let mut limits = ExtendedLimitInfo::new();
    limits.limit_kill_on_job_close();
    let job = Job::create_with_limit_info(&limits)?;
    job.assign_current_process()?;
    // Closing our self-containing job would terminate us before protocol flush.
    let job = std::mem::ManuallyDrop::new(job);
    let evidence = serde_json::json!({ "kind": "windows_job", "launchToken": launch.token, "helperPid": std::process::id(), "activeProcesses": null });
    send(serde_json::json!({ "version": 1, "type": "contained", "evidence": evidence }))?;
    if line(input)?.trim_end() != format!("ack {}", launch.token) {
        bail!("Controller admission was not acknowledged");
    }
    let output = std::io::stderr().as_handle().try_clone_to_owned()?;
    let mut trace =
        worktrunk::trace::CommandTrace::new(None, &launch.program.display().to_string());
    let result = (|| -> anyhow::Result<std::process::ExitStatus> {
        let mut child = Command::new(&launch.program)
            .args(&launch.args)
            .current_dir(&launch.cwd)
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::from(output))
            .stderr(Stdio::inherit())
            .spawn()
            .context("Managed command failed to start")?;
        child.wait().context("Managed command wait failed")
    })();
    match &result {
        Ok(status) => trace.complete(status.success()),
        Err(error) => trace.fail(error.as_ref()),
    }
    let status = result?;
    loop {
        // shortcut: more than 1024 job members fail closed; upgrade the wrapper before larger jobs.
        if job.query_process_id_list()? == [std::process::id() as usize] {
            let mut ended = evidence;
            ended["activeProcesses"] = 1.into();
            return send(
                serde_json::json!({ "version": 1, "type": "ended", "evidence": ended, "exitCode": status.code() }),
            );
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
