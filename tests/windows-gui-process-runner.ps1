$ErrorActionPreference = "Stop"

$runnerSource = Join-Path $PSScriptRoot "..\windows-gui\ReaGuiProcessRunner.cs"
Add-Type -Path $runnerSource

if (-not [Rea.WindowsGui.ReaGuiProcessRunner]::IsLocalPath($env:TEMP)) {
  throw "The local temporary directory was not recognized as a local path."
}
if ([Rea.WindowsGui.ReaGuiProcessRunner]::IsLocalPath("\\server\share\sample.exe")) {
  throw "A UNC target was accepted as a local path."
}

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = Join-Path $PSHOME "powershell.exe"
$startInfo.Arguments = '-NoLogo -NoProfile -Command "[Console]::WriteLine(''stdout-marker''); [Console]::Error.WriteLine(''stderr-marker''); exit 7"'
$runner = New-Object Rea.WindowsGui.ReaGuiProcessRunner($startInfo)
$runner.Start()

$output = New-Object 'System.Collections.Generic.List[string]'
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while (-not $runner.HasExited -and [DateTime]::UtcNow -lt $deadline) {
  $line = $null
  while ($runner.TryDequeue([ref]$line)) {
    $output.Add("[$($line.Stream)] $($line.Text)")
    $line = $null
  }
  Start-Sleep -Milliseconds 25
}
if (-not $runner.HasExited) {
  $runner.Dispose()
  throw "The fake CLI process did not finish within 15 seconds."
}

$runner.WaitForExit()
$line = $null
while ($runner.TryDequeue([ref]$line)) {
  $output.Add("[$($line.Stream)] $($line.Text)")
  $line = $null
}
$exitCode = $runner.ExitCode
$runner.Dispose()

if ($exitCode -ne 7) {
  throw "Expected fake CLI exit code 7; received $exitCode."
}
if (-not $output.Contains("[stdout] stdout-marker")) {
  throw "Standard output was not captured. Received: $($output -join '; ')"
}
if (-not $output.Contains("[stderr] stderr-marker")) {
  throw "Standard error was not captured. Received: $($output -join '; ')"
}

Write-Output "Windows GUI process runner test passed."
