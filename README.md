# Satellite Orbit Viewer

Local webpage that visualizes Earth-orbiting satellites from the CelesTrak
full catalog. Renders the globe with Natural Earth imagery (offline), groups
satellites by constellation, lets you scrub time ±14 days, and locks the
camera onto any satellite you click.

## Launch

From WSL:

```bash
cd /mnt/d/Projects/satellite_viewer && python3 -m http.server 8000
```

Or from Windows PowerShell:

```powershell
cd D:\Projects\satellite_viewer
D:\Python313\python.exe -m http.server 8000
```

Then open <http://localhost:8000> in a browser.

## Usage

- **Sidebar checkboxes** — turn whole constellations on/off (Starlink, GPS, etc.)
- **Search box** — find any satellite by name fragment or NORAD ID. Click a
  result to lock the camera onto it (this also turns its constellation on).
- **Click a dot on the globe** — locks the camera onto that satellite.
- **Esc / click empty space / "×" on the tracking chip** — release the lock.
- **Top-left animation widget** — play/pause and speed multiplier (1×, 60×,
  3600×, 86400×, plus reverse).
- **Top timeline ribbon** — drag the scrubber to jump to any point within
  ±14 days of now.

## Refresh the TLE catalog

The local TLE was pulled on 2026-05-22. To refresh:

```bash
curl -o /mnt/d/TLE_files/full_catalog_$(date +%Y-%m-%d_%H%MZ).tle \
  'https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=tle'
cp /mnt/d/TLE_files/full_catalog_<datestamp>.tle \
   /mnt/d/Projects/satellite_viewer/data/full_catalog.tle
```

CelesTrak rate-limits the full-catalog endpoint to one pull per IP per
2 hours. Pause the VPN if you hit the gate.

## Notes

- SGP4 accuracy drifts ~1 km/day past the TLE epoch — the page clamps the
  timeline to ±14 days, but accuracy beyond ~7 days is poor.
- 30K satellites at once will choke; turn off any group you're not using.
  Starlink alone is ~10,300 dots and runs smoothly.
