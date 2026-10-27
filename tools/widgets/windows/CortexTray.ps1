<#
  Savant tray pill for Windows (read-only). Shows a coloured dot in the notification area; hover for equity,
  positions, breakers and regime; right-click to open the web terminal or quit. No install, no admin rights.

  Setup: create %USERPROFILE%\.cortex54-pill with two lines (worker URL, read-only PILL_TOKEN), then run:
    powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File CortexTray.ps1
  To start it at login, put a shortcut to that command in shell:startup.
#>
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$conf = Join-Path $env:USERPROFILE ".cortex54-pill"
if (-not (Test-Path $conf)) { [System.Windows.Forms.MessageBox]::Show("Create $conf (URL, then PILL_TOKEN)"); exit }
$lines = Get-Content $conf
$url = $lines[0].TrimEnd('/')
$token = $lines[1]

function New-Dot([System.Drawing.Color]$c) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $c), 2, 2, 12, 12)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add("Open web terminal", $null, { Start-Process "$url/" })
[void]$menu.Items.Add("Quit", $null, { $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$tray.ContextMenuStrip = $menu

function Update-Pill {
  try {
    $p = Invoke-RestMethod -Uri "$url/pill" -Headers @{ authorization = "Bearer $token" } -TimeoutSec 8
    $paper = $p.accounts | Where-Object { $_.account -eq 'PAPER' } | Select-Object -First 1
    $warn = ($p.accounts | Where-Object { $_.breaker -ne 'GREEN' -or $_.mode -ne 'NORMAL' }).Count -gt 0
    $color = if (-not $p.ok) { 'Crimson' } elseif ($warn) { 'Orange' } else { 'MediumSeaGreen' }
    $tray.Icon = New-Dot ([System.Drawing.Color]::FromName($color))
    $eq = if ($paper.equity -ne $null) { '{0:N2}' -f $paper.equity } else { '-' }
    # tooltip text is limited to 63 characters
    $tip = "C54 `$$eq · $($p.symbols.Count) pos · $($paper.breaker) · pulse $($p.pulse_age_s)s"
    $tray.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length))
  } catch {
    $tray.Icon = New-Dot ([System.Drawing.Color]::Gray)
    $tray.Text = "C54 offline"
  }
}

Update-Pill
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.Add_Tick({ Update-Pill })
$timer.Start()
[System.Windows.Forms.Application]::Run()
