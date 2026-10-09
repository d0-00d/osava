# Runs the real, built app and checks what a person would meet: a plain launch, a second launch,
# a normal close, and a hard kill. See README.md in this folder.
#
#   .\final-test.ps1 -App C:\path\to\osava.exe
#
# It refuses to start while OSAVA is running or port 4000 is taken, because it ends every OSAVA
# process when it finishes. It never presses Install Sysmon (that raises an administrator prompt) and
# never starts monitoring.
param(
  [Parameter(Mandatory)][string]$App,
  [string]$Work = "$env:TEMP\osava-release-test"
)
$Tools = $PSScriptRoot
$log = "$env:USERPROFILE\.osava\backend.log"
$script:bad = 0
function Check($name, $ok, $detail = "") { if (-not $ok) { $script:bad++ }; "{0}  {1}{2}" -f $(if ($ok) { "PASS" } else { "FAIL" }), $name, $(if ($detail) { "  -- $detail" } else { "" }) }
function Alive { Get-Process osava,osava-backend,llama-server -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessName)#$($_.Id)" } }
function Listening($port) { @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).Count -gt 0 }
function WaitUntil($cond, $seconds) { $end = (Get-Date).AddSeconds($seconds); while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 200 }; return [bool](& $cond) }
function Healthy { try { (Invoke-RestMethod http://127.0.0.1:4000/health -TimeoutSec 1).status -eq "ok" } catch { $false } }

if (-not (Test-Path $App)) { "No such file: $App"; exit 2 }
if (@(Alive).Count -or (Listening 4000) -or (Listening 9223)) {
  "OSAVA is running, or port 4000 / 9223 is taken. Close it first; this test ends every OSAVA process when it is done."
  "  running: " + ((Alive) -join ", "); exit 3
}
"App under test: $App  ($((Get-Item $App).LastWriteTime))"

$profile_ = "$Work\webview-profile"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
$env:WEBVIEW2_USER_DATA_FOLDER = $profile_
Remove-Item $profile_ -Recurse -Force -ErrorAction SilentlyContinue
$logBefore = if (Test-Path $log) { @(Get-Content $log).Count } else { 0 }
try {
  "`n===== 1. a plain launch, judged by what the window shows"
  $p1 = Start-Process $App -PassThru
  $kids = @(); [void](WaitUntil { $script:kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p1.Id)" | Where-Object { $_.Name -eq "osava-backend.exe" }); $script:kids.Count -ge 1 } 10)
  Check "the app started its own backend (osava-backend.exe is its child)" ($kids.Count -ge 1)
  node "$Tools\qa-launch.mjs" "$Work\shots" 2>&1 | Where-Object { $_ -match "^(PASS|FAIL|ALL|SOME)" }
  if ($LASTEXITCODE -ne 0) { $script:bad++ }

  "`n===== 2. opening it a second time"
  $p2 = Start-Process $App -PassThru
  Check "the second copy exits by itself" (WaitUntil { $p2.HasExited } 8)
  Check "there is still exactly one osava.exe and one backend" ((@(Get-Process osava -ErrorAction SilentlyContinue).Count -eq 1) -and (@(Get-Process osava-backend -ErrorAction SilentlyContinue).Count -eq 1)) ((Alive) -join ", ")
  Check "the first copy's backend still answers" (Healthy)

  "`n===== 3. closing the window the normal way"
  [void]$p1.CloseMainWindow()
  Check "nothing is left running" (WaitUntil { @(Alive).Count -eq 0 } 8) ((Alive) -join ", ")
  Check "port 4000 is free again" (-not (Listening 4000))

  "`n===== 4. the app is killed hard (a crash, Task Manager, an installer replacing it)"
  $p3 = Start-Process $App -PassThru
  Check "the backend is up" (WaitUntil { Healthy } 15)
  $t = Get-Date
  Stop-Process -Id $p3.Id -Force
  Check "the backend leaves too" (WaitUntil { @(Get-Process osava-backend -ErrorAction SilentlyContinue).Count -eq 0 } 10) ("after {0:N1}s; still running: {1}" -f ((Get-Date) - $t).TotalSeconds, ((Alive) -join ", "))
  Check "port 4000 is free again" (-not (Listening 4000))

  "`n===== 5. what the backend wrote to its log"
  $newLog = if (Test-Path $log) { (Get-Content $log | Select-Object -Skip $logBefore) -join "`n" } else { "" }
  $newLog -split "`n" | ForEach-Object { "    $_" }
  Check "it logged starting, and why it stopped" (($newLog -match "started on port 4000") -and ($newLog -match "is gone: stopping"))
}
finally {
  Get-Process osava,osava-backend,llama-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like "*$profile_*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
"`n" + $(if ($script:bad -eq 0) { "ALL PASS" } else { "$($script:bad) CHECK(S) FAILED" })
"processes left: " + @(Alive).Count
exit $script:bad
