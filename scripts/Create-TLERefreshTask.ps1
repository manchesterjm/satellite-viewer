# Create-TLERefreshTask.ps1
# One-time admin script to register the "TLE Catalog Refresh" scheduled task.
# Runs Refresh-TLEs.ps1 every 3 days at 03:30 local time. Hidden window
# (PowerShell -WindowStyle Hidden, matching the weather-task pattern).

$taskName = "TLE Catalog Refresh"
$script   = "D:\Scripts\Refresh-TLEs.ps1"

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""

$trigger = New-ScheduledTaskTrigger `
    -Daily `
    -DaysInterval 3 `
    -At "03:30"

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
    -Description "Pull fresh CelesTrak full satellite catalog every 3 days for the satellite viewer." `
    -Force

Write-Host "Registered task '$taskName'. Next run: $((Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo).NextRunTime)"
