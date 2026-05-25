# AmbientForge — always-on-top cover picker.
#
# Polls the freepik bridge (:7344) /pick-state. When the pipeline's step-05a
# offers the 4 generated medieval-path covers, this window pops to the front
# with a sound and shows them so the operator can choose INSTANTLY — no need
# to watch the Magnific tab. The choice is POSTed back to /pick-choice; the
# freepik content script resolves the pick from it.
#
# Launched by make-medieval-video.bat. Closing the window is safe — the
# pipeline still falls back to clicking the image in the Magnific tab.

param([string]$BridgeUrl = 'http://localhost:7344')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# Win32 force-to-front. A background poller (this script) cannot steal the
# foreground from a fullscreen app via .Activate()/TopMost-toggle alone —
# Windows' foreground lock demotes that to a taskbar flash. The reliable
# workaround: a synthetic ALT keypress satisfies the "user just provided
# input" exemption, then SetForegroundWindow + SetWindowPos(HWND_TOPMOST)
# actually raise + focus the window; FlashWindow is the last-resort fallback.
$fgSig = @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern int FlashWindow(IntPtr hWnd, bool bInvert);
'@
Add-Type -MemberDefinition $fgSig -Name 'Fg' -Namespace 'AF' -ErrorAction Stop

$script:currentOffer = $null
$script:busy = $false

$form = New-Object System.Windows.Forms.Form
$form.Text = 'AmbientForge - pick the medieval-path cover'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(1200, 900)   # restore size only
$form.WindowState = 'Maximized'                            # fill the screen
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(17, 24, 39)

$grid = New-Object System.Windows.Forms.TableLayoutPanel
$grid.Dock = 'Fill'
$grid.BackColor = [System.Drawing.Color]::FromArgb(17, 24, 39)
$grid.Padding = New-Object System.Windows.Forms.Padding(6)
$form.Controls.Add($grid)

$status = New-Object System.Windows.Forms.Label
$status.Dock = 'Top'
$status.Height = 50
$status.TextAlign = 'MiddleCenter'
$status.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$status.ForeColor = [System.Drawing.Color]::White
$status.Text = 'Waiting for the 4 cover images...'
$form.Controls.Add($status)

function New-BitmapFromData {
    param([string]$Data)
    if ([string]::IsNullOrWhiteSpace($Data)) { return $null }
    $b64 = $Data
    $comma = $Data.IndexOf(',')
    if ($Data.StartsWith('data:') -and $comma -ge 0) { $b64 = $Data.Substring($comma + 1) }
    try {
        $bytes = [System.Convert]::FromBase64String($b64)
        $ms = New-Object System.IO.MemoryStream(, $bytes)
        $img = [System.Drawing.Image]::FromStream($ms)
        # Copy into a standalone Bitmap so the Image no longer depends on the
        # MemoryStream (GDI+ keeps a handle to the stream otherwise).
        $bmp = New-Object System.Drawing.Bitmap $img
        $img.Dispose()
        $ms.Dispose()
        return $bmp
    } catch {
        return $null
    }
}

function New-PlaceholderBitmap {
    $bmp = New-Object System.Drawing.Bitmap 380, 380
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromArgb(55, 65, 81))
    $f = New-Object System.Drawing.Font('Segoe UI', 11)
    $br = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $g.DrawString('(preview unavailable - still pickable)', $f, $br, 24, 175)
    $g.Dispose()
    return $bmp
}

function Set-Foreground {
    param([IntPtr]$Handle)
    if ($Handle -eq [IntPtr]::Zero) { return }
    try {
        [AF.Fg]::ShowWindow($Handle, 9) | Out-Null   # SW_RESTORE (un-minimize)
        # ALT down+up — satisfies the SetForegroundWindow input exemption so
        # the OS lets this background poller pull focus off fullscreen Chrome.
        [AF.Fg]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [AF.Fg]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)   # KEYEVENTF_KEYUP
        [AF.Fg]::SetForegroundWindow($Handle) | Out-Null
        [AF.Fg]::BringWindowToTop($Handle) | Out-Null
        $HWND_TOPMOST = [IntPtr](-1)
        $SWP = 0x0001 -bor 0x0002 -bor 0x0040   # NOSIZE | NOMOVE | SHOWWINDOW
        [AF.Fg]::SetWindowPos($Handle, $HWND_TOPMOST, 0, 0, 0, 0, $SWP) | Out-Null
        [AF.Fg]::FlashWindow($Handle, $true) | Out-Null
    } catch { }
}

function Show-Offer {
    param($Offer)
    $grid.Controls.Clear()
    $grid.ColumnStyles.Clear()
    $grid.RowStyles.Clear()
    $imgList = @($Offer.images)
    $n = $imgList.Count
    if ($n -lt 1) { $n = 1 }
    # Adaptive square-ish grid: 4 covers -> 2x2 quadrants filling the screen.
    $cols = [int][math]::Ceiling([math]::Sqrt($n))
    $rows = [int][math]::Ceiling($n / [double]$cols)
    $grid.ColumnCount = $cols
    $grid.RowCount = $rows
    for ($c = 0; $c -lt $cols; $c++) {
        $grid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, (100.0 / $cols)))) | Out-Null
    }
    for ($r = 0; $r -lt $rows; $r++) {
        $grid.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, (100.0 / $rows)))) | Out-Null
    }
    $idx = 0
    foreach ($data in $imgList) {
        $bmp = New-BitmapFromData -Data $data
        if ($null -eq $bmp) { $bmp = New-PlaceholderBitmap }
        $pb = New-Object System.Windows.Forms.PictureBox
        $pb.Dock = 'Fill'
        $pb.SizeMode = 'Zoom'
        $pb.BackColor = [System.Drawing.Color]::Black
        $pb.Margin = New-Object System.Windows.Forms.Padding(6)
        $pb.Cursor = [System.Windows.Forms.Cursors]::Hand
        $pb.Image = $bmp
        $pb.Tag = $idx
        $pb.Add_Click({ param($s, $e) Submit-Choice ([int]$s.Tag) })
        $grid.Controls.Add($pb, ($idx % $cols), [int][math]::Floor($idx / $cols))
        $idx++
    }
    $status.Text = 'Click the cover you want to use'
    try { [System.Media.SystemSounds]::Exclamation.Play() } catch {}
    $form.TopMost = $true
    # Forcefully raise above fullscreen Chrome (only fires here, on a NEW
    # offer — Poll-Bridge gates this so it never re-grabs focus every tick).
    Set-Foreground -Handle $form.Handle
    # Re-assert maximized LAST: Set-Foreground's SW_RESTORE can un-maximize.
    $form.WindowState = 'Maximized'
    $form.Activate()
}

function Submit-Choice {
    param([int]$Index)
    if ($script:busy -or -not $script:currentOffer) { return }
    $script:busy = $true
    try {
        $body = @{ offerId = $script:currentOffer; index = $Index } | ConvertTo-Json
        Invoke-RestMethod -Uri "$BridgeUrl/pick-choice" -Method Post -Body $body `
            -ContentType 'application/json' -TimeoutSec 5 -ErrorAction Stop | Out-Null
        $status.Text = "Picked #$($Index + 1) - generating the video..."
        $grid.Controls.Clear()
        $script:currentOffer = $null
    } catch {
        $status.Text = "Could not send pick: $($_.Exception.Message) - click again"
    } finally {
        $script:busy = $false
    }
}

function Poll-Bridge {
    try {
        $resp = Invoke-RestMethod -Uri "$BridgeUrl/pick-state" -TimeoutSec 4 -ErrorAction Stop
    } catch {
        if (-not $script:currentOffer) {
            $status.Text = 'Waiting for the cover picker (freepik bridge :7344)...'
        }
        return
    }
    if ($resp -and $resp.offerId) {
        if ($script:currentOffer -ne $resp.offerId -and -not $script:busy) {
            $script:currentOffer = $resp.offerId
            Show-Offer -Offer $resp
        }
    } else {
        if ($script:currentOffer -and -not $script:busy) {
            $script:currentOffer = $null
            $grid.Controls.Clear()
        }
        if (-not $script:busy -and -not $script:currentOffer) {
            $status.Text = 'Waiting for the 4 cover images...'
        }
    }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Poll-Bridge })

$form.Add_Shown({ Poll-Bridge; $timer.Start() })
$form.Add_FormClosing({ $timer.Stop() })

[System.Windows.Forms.Application]::Run($form)
