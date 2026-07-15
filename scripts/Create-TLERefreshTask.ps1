# Create-TLERefreshTask.ps1
# One-time admin script to register the "TLE Catalog Refresh" scheduled task.
# Runs Refresh-TLEs.ps1 every 6 hours starting at 03:30 local (03:30, 09:30,
# 15:30, 21:30). Hidden window (PowerShell -WindowStyle Hidden, matching the
# weather-task pattern).

$taskName = "TLE Catalog Refresh"
$script   = "D:\Scripts\Refresh-TLEs.ps1"

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""

$trigger = New-ScheduledTaskTrigger `
    -Daily `
    -At "03:30"
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At "03:30" `
    -RepetitionInterval (New-TimeSpan -Hours 6) `
    -RepetitionDuration (New-TimeSpan -Hours 24)).Repetition

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Pull fresh CelesTrak full satellite catalog every 6 hours for the satellite viewer." `
    -Force

Write-Host "Registered task '$taskName'. Next run: $((Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo).NextRunTime)"
