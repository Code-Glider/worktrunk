param([int]$FixtureProcessId, [switch]$Resume)
$ErrorActionPreference = 'Stop'
# Only used by the test on its own disposable descendant, never by the controller.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureThread {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenThread(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint SuspendThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
foreach ($FixtureThreadInfo in (Get-Process -Id $FixtureProcessId).Threads) {
    $FixtureHandle = [FixtureThread]::OpenThread(2, $false, $FixtureThreadInfo.Id)
    if ($FixtureHandle -eq [IntPtr]::Zero) { throw 'Fixture thread open failed' }
    try {
        if ($Resume) { $FixtureCount = [FixtureThread]::ResumeThread($FixtureHandle) }
        else { $FixtureCount = [FixtureThread]::SuspendThread($FixtureHandle) }
        if ($FixtureCount -eq [uint32]::MaxValue) { throw 'Fixture suspend/resume failed' }
    } finally { [void][FixtureThread]::CloseHandle($FixtureHandle) }
}
