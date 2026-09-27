# Registers/unregisters the daily Freebuff streak keeper task (21:00 local =
# 18:00 UTC; the daily allowance resets at 21:00 UTC and TRT has no DST).
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$taskName = 'Freebuff Streak Keeper'
$repoRoot = Split-Path $PSScriptRoot -Parent

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "removed '$taskName'"
    exit 0
}

$action = New-ScheduledTaskAction -Execute 'node.exe' -Argument 'scripts\streak-keeper.mjs' -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At '21:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable   # fires on next boot if 21:00 was missed
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "registered '$taskName': daily 21:00, node scripts\streak-keeper.mjs in $repoRoot"
