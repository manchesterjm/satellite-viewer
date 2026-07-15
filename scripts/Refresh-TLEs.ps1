# Refresh-TLEs.ps1
# Pulls the CelesTrak full satellite catalog and refreshes the local TLE store.
# Saves a datestamped copy in D:\TLE_files\ and updates the working copy in
# D:\Projects\satellite_viewer\data\full_catalog.tle so the viewer always uses
# the latest pull.
#
# Scheduled to run every 6 hours. CelesTrak rate-limits the full-catalog
# endpoint to one pull per IP per 2 hours.

$ErrorActionPreference = "Stop"

$tleDir   = "D:\TLE_files"
$workCopy = "D:\Projects\satellite_viewer\data\full_catalog.tle"
$logFile  = "D:\Scripts\tle_refresh.log"
$url      = "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=tle"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Add-Content -Path $logFile -Value $line
}

try {
    if (-not (Test-Path $tleDir)) { New-Item -ItemType Directory -Path $tleDir | Out-Null }

    # Skip if the most recent file is < 5 hours old (safety against rapid re-runs;
    # also keeps us above CelesTrak's 2-hour per-IP rate limit on the full catalog).
    $latest = Get-ChildItem $tleDir -Filter "full_catalog_*.tle" -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest -and ((Get-Date) - $latest.LastWriteTime).TotalHours -lt 5) {
        Write-Log "Skip: latest file '$($latest.Name)' is only $([math]::Round(((Get-Date) - $latest.LastWriteTime).TotalHours, 1))h old"
        exit 0
    }

    $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd_HHmm") + "Z"
    $dest  = Join-Path $tleDir "full_catalog_$stamp.tle"

    Write-Log "Fetching from CelesTrak ..."
    Invoke-WebRequest -Uri $url -OutFile $dest -TimeoutSec 120 -UseBasicParsing

    $size = (Get-Item $dest).Length
    if ($size -lt 1MB) {
        Write-Log "ERROR: Downloaded file is only $size bytes (rate-limited or error page)"
        Remove-Item $dest
        exit 1
    }

    Write-Log "Saved: $dest ($([math]::Round($size/1MB,2)) MB)"

    # Update the working copy used by the satellite viewer
    Copy-Item -Path $dest -Destination $workCopy -Force
    Write-Log "Updated working copy: $workCopy"

    # Keep only the 28 most recent datestamped files (~7 days of history at 4 pulls/day)
    $keep = 28
    $old = Get-ChildItem $tleDir -Filter "full_catalog_*.tle" |
           Sort-Object LastWriteTime -Descending | Select-Object -Skip $keep
    foreach ($f in $old) {
        Remove-Item $f.FullName
        Write-Log "Pruned old file: $($f.Name)"
    }
}
catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    exit 1
}
