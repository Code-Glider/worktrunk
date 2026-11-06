#requires -Version 7.0
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][string]$Config,
    [ValidateRange(1, 86400)][int]$TimeoutSeconds = 900
)

$ErrorActionPreference = 'Stop'
$lock = $null
try {
    if (-not $IsWindows) { throw 'This scheduling example requires native Windows and PowerShell 7' }
    foreach ($filename in @($Node, $Config)) {
        if (-not [IO.Path]::IsPathFullyQualified($filename) -or -not (Test-Path -LiteralPath $filename -PathType Leaf)) {
            throw 'Node and Config must name existing absolute files'
        }
    }
    $Node = (Resolve-Path -LiteralPath $Node).ProviderPath
    $Config = (Resolve-Path -LiteralPath $Config).ProviderPath
    # Keep the file: unlinking an unlocked path would race the next runner.
    $lock = [IO.File]::Open("$Config.scan-report.lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $to = [DateTime]::UtcNow.Date
    $from = $to.AddDays(-7)
    $controller = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../bin/controller.mjs'))

    function Invoke-Observation([string[]]$Arguments) {
        $remaining = [int][Math]::Floor($TimeoutSeconds * 1000 - $clock.Elapsed.TotalMilliseconds)
        if ($remaining -le 0) { throw 'Scan/report wait budget exhausted' }
        $info = [Diagnostics.ProcessStartInfo]::new($Node)
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.ArgumentList.Add($controller)
        foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
        $process_ = [Diagnostics.Process]::new()
        $process_.StartInfo = $info
        try {
            if (-not $process_.Start()) { throw 'Observation process did not start' }
            $drains = [Threading.Tasks.Task[]]@(
                $process_.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput()),
                $process_.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
            )
            $remaining = [int][Math]::Max(0, [Math]::Floor($TimeoutSeconds * 1000 - $clock.Elapsed.TotalMilliseconds))
            if (-not $process_.WaitForExit($remaining)) {
                $process_.Kill($true)
                if (-not $process_.WaitForExit(5000)) { throw 'Observation termination could not be confirmed' }
                throw 'Scan/report wait budget exhausted; termination requested for the observation process tree'
            }
            $remaining = [int][Math]::Max(0, [Math]::Floor($TimeoutSeconds * 1000 - $clock.Elapsed.TotalMilliseconds))
            if (-not [Threading.Tasks.Task]::WaitAll($drains, $remaining)) { throw 'Scan/report wait budget exhausted while forwarding output' }
            if ($process_.ExitCode -ne 0) { throw "Observation command failed with exit $($process_.ExitCode)" }
        } finally { $process_.Dispose() }
    }

    Invoke-Observation -Arguments @('scan', '--config', $Config)
    Invoke-Observation -Arguments @('report', '--config', $Config, '--from', $from.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture), '--to', $to.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally { if ($null -ne $lock) { $lock.Dispose() } }
