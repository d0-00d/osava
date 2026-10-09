# Installs the NSIS setup silently for the current user into a scratch folder, runs final-test.ps1 on the
# installed copy, installs again over a copy that is RUNNING, uninstalls, and checks the PC is as it was.
# See README.md in this folder.
#
#   .\installer-test.ps1 -Setup C:\path\to\osava-installtest_0.3.0_x64-setup.exe
#
# -Match is a piece of the product name the setup registers under. The default is for a build whose
# product name was changed to "osava-installtest", which is how to run this on a PC that already has
# OSAVA installed: that install is described first, compared at the end, and never touched. On a clean
# PC, use the real setup with -Match osava.
#
# It never raises an administrator prompt: it reads the setup's manifest first and stops if it would.
param(
  [Parameter(Mandatory)][string]$Setup,
  [string]$Match = "osava-installtest",
  [string]$Identifier = "com.ayush.osava.installtest",
  [string]$Work = "$env:TEMP\osava-release-test"
)
$Tools = $PSScriptRoot
$root = "$Work\inst"; $dir = "$root\OSAVA"
$lnkDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
$script:bad = 0
function Check($name, $ok, $detail = "") { if (-not $ok) { $script:bad++ }; "{0}  {1}{2}" -f $(if ($ok) { "PASS" } else { "FAIL" }), $name, $(if ($detail) { "  -- $detail" } else { "" }) }
function Alive { Get-Process osava,osava-backend,llama-server -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessName)#$($_.Id)" } }
function UninstallsAll { Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall","HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall","HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like "*osava*" } }
function Uninstalls { UninstallsAll | Where-Object { $_.DisplayName -like "*$Match*" } }
function Shortcuts { @(Get-ChildItem $lnkDir -Recurse -Filter "*$Match*.lnk" -ErrorAction SilentlyContinue) + @(Get-ChildItem ([Environment]::GetFolderPath("Desktop")) -Filter "*$Match*.lnk" -ErrorAction SilentlyContinue) }
# Whatever OSAVA is already on this PC belongs to the person who owns it: describe it now, compare it at the end.
function Mine {
  $o = @(UninstallsAll | Where-Object { $_.DisplayName -notlike "*$Match*" }) | ForEach-Object {
    $loc = ([string]$_.InstallLocation).Trim('"')
    "{0} {1} at {2}; exe {3}" -f $_.DisplayName, $_.DisplayVersion, $loc, $(if ($loc -and (Test-Path "$loc\osava.exe")) { (Get-Item "$loc\osava.exe").LastWriteTimeUtc.Ticks } else { "none" }) }
  $l = @(Get-ChildItem $lnkDir -Recurse -Filter "*.lnk" -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "osava*.lnk" -and $_.Name -notlike "*$Match*" }) | ForEach-Object { "{0} {1}" -f $_.FullName, $_.LastWriteTimeUtc.Ticks }
  (@($o) + @($l)) -join "`n"
}

if (-not (Test-Path $Setup)) { "No such file: $Setup"; exit 2 }
"Setup: $Setup"
$mineBefore = Mine
if (@(Uninstalls).Count -or @(Shortcuts).Count -or @(Alive).Count) {
  "Something from an earlier run of this test, or a running OSAVA, is here; stopping."
  UninstallsAll | Where-Object { $_.DisplayName -like "*$Match*" } | ForEach-Object { "  registry: $($_.DisplayName) $($_.DisplayVersion) at $($_.InstallLocation)" }
  "  processes: " + ((Alive) -join ", "); exit 3
}
if ($mineBefore) { "Already on this PC, and left strictly alone:`n" + (($mineBefore -split "`n" | ForEach-Object { "    $_" }) -join "`n") }

# Would it ask for administrator rights? A prompt nobody answers would hang a silent install.
$text = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($Setup))
$level = [regex]::Match($text, 'requestedExecutionLevel[^/>]*').Value
Check "the setup asks for no administrator rights" ($level -match 'asInvoker') $level
if ($level -notmatch 'asInvoker') { exit 4 }

function Install($label) {
  $t = Get-Date
  $p = Start-Process $Setup -ArgumentList "/S", "/D=$dir" -PassThru
  $done = $p.WaitForExit(120000)
  if (-not $done) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Check "$label finishes by itself with exit code 0" ($done -and $p.ExitCode -eq 0) ("{0:N1}s, exit {1}" -f ((Get-Date) - $t).TotalSeconds, $(if ($done) { $p.ExitCode } else { "timeout" }))
}
function WaitHealthy { for ($i = 0; $i -lt 60; $i++) { try { if ((Invoke-RestMethod http://127.0.0.1:4000/health -TimeoutSec 1).status -eq "ok") { return $true } } catch {}; Start-Sleep -Milliseconds 250 }; $false }
try {
  "`n===== 1. a fresh install"
  New-Item -ItemType Directory -Force $root | Out-Null
  Install "install"
  Check "the app and its backend are in the install folder" ((Test-Path "$dir\osava.exe") -and (Test-Path "$dir\osava-backend.exe")) ((Get-ChildItem $dir -Name) -join ", ")
  Check "an uninstaller was written" (Test-Path "$dir\uninstall.exe")
  $u = @(Uninstalls)
  Check "it registered itself for the current user only (Settings > Apps)" (($u.Count -eq 1) -and ($u[0].PSPath -like "*HKEY_CURRENT_USER*")) (($u | ForEach-Object { "$($_.DisplayName) $($_.DisplayVersion) by '$($_.Publisher)'" }) -join "; ")
  Check "it made a shortcut" (@(Shortcuts).Count -ge 1) ((Shortcuts | ForEach-Object FullName) -join ", ")
  Check "the installer started nothing" (@(Alive).Count -eq 0) ((Alive) -join ", ")

  "`n===== 2. the INSTALLED app, through the same sequence as final-test.ps1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Tools\final-test.ps1" -App "$dir\osava.exe" -Work $Work 2>&1 | ForEach-Object { "  $_" }
  if ($LASTEXITCODE -ne 0) { $script:bad++ }
  Start-Sleep -Seconds 2

  "`n===== 3. installing again over a copy that is RUNNING"
  $env:WEBVIEW2_USER_DATA_FOLDER = "$Work\webview-profile"
  [void](Start-Process "$dir\osava.exe" -PassThru)
  Check "the running copy is up" (WaitHealthy) ((Alive) -join ", ")
  Install "upgrade over the running copy"
  Check "the new files are in place" ((Test-Path "$dir\osava.exe") -and (Test-Path "$dir\osava-backend.exe"))
  Start-Sleep -Seconds 3
  "    processes after the upgrade: " + $(if (@(Alive).Count) { (Alive) -join ", " } else { "none" })
  Get-Process osava,osava-backend,llama-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  [void](Start-Process "$dir\osava.exe" -PassThru)
  Check "the upgraded app starts and its backend answers" (WaitHealthy)
  Get-Process osava,osava-backend,llama-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}
finally {
  "`n===== 4. uninstall, and put the PC back as it was"
  Get-Process osava,osava-backend,llama-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  if (Test-Path "$dir\uninstall.exe") {
    $p = Start-Process "$dir\uninstall.exe" -ArgumentList "/S" -PassThru
    [void]$p.WaitForExit(60000)
    for ($i = 0; $i -lt 60 -and (Test-Path "$dir\osava.exe"); $i++) { Start-Sleep -Milliseconds 500 }   # the NSIS uninstaller finishes from a temp copy
    Start-Sleep -Seconds 2
  }
  Check "the program files are gone" (-not (Test-Path "$dir\osava.exe") -and -not (Test-Path "$dir\osava-backend.exe")) ((Get-ChildItem $dir -Name -ErrorAction SilentlyContinue) -join ", ")
  Check "the registry entry is gone" (@(Uninstalls).Count -eq 0)
  Check "the shortcut is gone" (@(Shortcuts).Count -eq 0) ((Shortcuts | ForEach-Object FullName) -join ", ")
  Check "the user's own data (%USERPROFILE%\.osava) was left alone" (Test-Path "$env:USERPROFILE\.osava")
  Check "the OSAVA that was already on this PC is exactly as it was" ((Mine) -eq $mineBefore) $(if ((Mine) -ne $mineBefore) { "before:`n$mineBefore`nafter:`n$(Mine)" })
  # Tauri's uninstaller leaves an empty Software\<publisher>\<product> key behind. Harmless, but say so;
  # a test build's is the test's to remove.
  $left = @(Get-ChildItem "HKCU:\Software" -ErrorAction SilentlyContinue | ForEach-Object { Get-ChildItem $_.PSPath -ErrorAction SilentlyContinue } | Where-Object { $_.PSChildName -like "*$Match*" })
  "    the uninstaller left $($left.Count) registry key(s) behind" + $(if ($left.Count) { ": " + (($left | ForEach-Object Name) -join ", ") })
  if ($Identifier -like "*installtest*") { $left | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like "*$Work*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # The WebView2 data of a test build is the test's own to delete. A real identifier's is not.
  if ($Identifier -like "*installtest*") { foreach ($d in "$env:LOCALAPPDATA\$Identifier", "$env:APPDATA\$Identifier") { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue } }
}
"`n" + $(if ($script:bad -eq 0) { "ALL PASS" } else { "$($script:bad) CHECK(S) FAILED" })
"processes left: " + @(Alive).Count + "; scratch install folder exists: " + (Test-Path $root)
exit $script:bad
