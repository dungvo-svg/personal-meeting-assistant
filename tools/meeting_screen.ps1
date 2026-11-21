<#
.SYNOPSIS
  Watch the Zoom meeting window (read only) and write what the screen shows: who is sharing and when, who Zoom marks as
  speaking, and one frame of the shared screen each time its content changes.

.DESCRIPTION
  Nothing is clicked or opened in Zoom. Every -Interval seconds:
   - share on/off: the meeting window's UI Automation tree has a "Share Content" pane while someone shares, "Video content"
     otherwise (seen live 21/11: the Annotation window toggles on its own and is not used);
   - who shares: Windows OCR (offline, en-US) of the tab title "<name>'s screen";
   - who speaks: the tile Zoom outlines in #00FF91 in the top strip, its name label read by OCR; in speaker view without a
     strip outline, the label at the bottom left of the main video;
   - frames: PrintWindow of the meeting window (works when another window covers Zoom, not when it is minimized); while
     sharing, a frame is saved when a 32x18 grey signature of the content area changes.
  Output: <OutDir>/screen.jsonl (one JSON event per line, local time and UTC) and <OutDir>/frames/*.png. Events are also
  printed, so `Monitor` can follow them. The images can hold internal data (prices, suppliers): they stay on this machine.
#>
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [double]$Interval = 2,
  [int]$FrameDiff = 12,     # mean absolute grey difference (0-255) that counts as new shared content
  [int]$MaxMinutes = 0      # 0 = until stopped
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, UIAutomationClient, UIAutomationTypes, System.Runtime.WindowsRuntime
Add-Type -ReferencedAssemblies System.Drawing @"
using System; using System.Text; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class MeetingScreen {
  public delegate bool EP(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EP f, IntPtr l);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  public static IntPtr FindMeeting() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { var c = new StringBuilder(128); GetClassName(h, c, 128);
      if (c.ToString() == "ConfMultiTabContentWndClass" && IsWindowVisible(h)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static bool Minimized(IntPtr h) { return IsIconic(h); }
  public static Bitmap Capture(IntPtr h) {
    RECT r; GetWindowRect(h, out r); int w = r.R - r.L, ht = r.B - r.T; if (w < 100 || ht < 100) return null;
    var b = new Bitmap(w, ht, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(b)) { var dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
    return b;
  }
  static byte[] Bytes(Bitmap b, out int stride) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    stride = d.Stride; var a = new byte[stride * b.Height]; Marshal.Copy(d.Scan0, a, 0, a.Length); b.UnlockBits(d); return a;
  }
  // The active-speaker outline: columns in the top strip (y0..y1) with many #00FF91 pixels. Returns {left, right} or null.
  public static int[] SpeakerTile(Bitmap b, int y0, int y1) {
    int stride; var a = Bytes(b, out stride); int left = -1, right = -1; y1 = Math.Min(y1, b.Height - 1);
    for (int x = 0; x < b.Width; x++) {
      int n = 0;
      for (int y = y0; y <= y1; y++) { int i = y * stride + x * 4; if (a[i + 2] < 20 && a[i + 1] > 240 && a[i] > 120 && a[i] < 170) n++; }
      if (n > (y1 - y0) / 2) { if (left < 0) left = x; right = x; }
    }
    return left >= 0 && right - left > 40 ? new int[] { left, right } : null;
  }
  public static byte[] Signature(Bitmap b, Rectangle r) {
    var s = new byte[32 * 18];
    using (var small = new Bitmap(32, 18)) {
      using (var g = Graphics.FromImage(small)) g.DrawImage(b, new Rectangle(0, 0, 32, 18), r, GraphicsUnit.Pixel);
      for (int y = 0; y < 18; y++) for (int x = 0; x < 32; x++) { var c = small.GetPixel(x, y); s[y * 32 + x] = (byte)((c.R + c.G + c.B) / 3); }
    }
    return s;
  }
  public static int Diff(byte[] a, byte[] b) { if (a == null || b == null) return 255; long t = 0; for (int i = 0; i < a.Length; i++) t += Math.Abs(a[i] - b[i]); return (int)(t / a.Length); }
  public static Bitmap Crop(Bitmap b, Rectangle r) { r.Intersect(new Rectangle(0, 0, b.Width, b.Height)); return r.Width > 4 && r.Height > 4 ? b.Clone(r, b.PixelFormat) : null; }
}
"@

# Windows OCR (WinRT) from PowerShell 5.1: await the async calls through AsTask.
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$tmp = Join-Path $env:TEMP ("pma-ocr-" + $PID + ".png")
function Ocr($bmp) {
  if (-not $bmp) { return '' }
  # Small labels read better scaled up
  $big = New-Object System.Drawing.Bitmap ($bmp.Width * 2), ($bmp.Height * 2)
  $g = [System.Drawing.Graphics]::FromImage($big); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($bmp, 0, 0, $big.Width, $big.Height); $g.Dispose()
  $big.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png); $big.Dispose(); $bmp.Dispose()
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
    return (($res.Lines | ForEach-Object { $_.Text }) -join ' ').Trim()
  } finally { $stream.Dispose() }
}

function Sharing($hwnd) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Share Content')
  return $null -ne $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

New-Item -ItemType Directory -Force (Join-Path $OutDir 'frames') | Out-Null
$log = Join-Path $OutDir 'screen.jsonl'
function Emit([hashtable]$e) {
  $now = Get-Date
  $o = [ordered]@{ at = $now.ToString('HH:mm:ss'); utc = $now.ToUniversalTime().ToString('o') }
  foreach ($k in $e.Keys) { $o[$k] = $e[$k] }
  $line = $o | ConvertTo-Json -Compress
  Add-Content -Encoding utf8 $log $line
  Write-Output $line
}

$state = @{ zoom = $null; share = $false; by = $null; speaker = $null; sig = $null; tileX = $null; ocrAt = [datetime]::MinValue; black = 0 }
$started = Get-Date
Emit @{ type = 'start'; interval = $Interval; out = $OutDir }
while ($MaxMinutes -le 0 -or ((Get-Date) - $started).TotalMinutes -lt $MaxMinutes) {
  try {
    $h = [MeetingScreen]::FindMeeting()
    $zoom = if ($h -eq [IntPtr]::Zero) { 'none' } elseif ([MeetingScreen]::Minimized($h)) { 'minimized' } else { 'visible' }
    if ($zoom -ne $state.zoom) { Emit @{ type = 'zoom'; window = $zoom }; $state.zoom = $zoom }
    if ($zoom -ne 'visible') {
      if ($zoom -eq 'none' -and $state.share) { Emit @{ type = 'share_stop'; by = $state.by; reason = 'no meeting window' }; $state.share = $false }
      Start-Sleep -Seconds $Interval; continue
    }
    $share = Sharing $h
    $bmp = [MeetingScreen]::Capture($h)
    if (-not $bmp) { Start-Sleep -Seconds $Interval; continue }
    $W = $bmp.Width; $H = $bmp.Height

    if ($share -and -not $state.share) {
      $tab = Ocr ([MeetingScreen]::Crop($bmp, (New-Object System.Drawing.Rectangle 380, 8, 460, 44)))
      $by = if ($tab -match "^(.+?)['’]s screen") { $Matches[1].Trim() } else { $null }
      Emit @{ type = 'share_start'; by = $by; tab = $tab }
      $state.by = $by; $state.sig = $null
    } elseif (-not $share -and $state.share) {
      Emit @{ type = 'share_stop'; by = $state.by }; $state.by = $null
    }
    $state.share = $share

    # Who Zoom marks as speaking: OCR only when the outlined tile moves, or every 10 s to catch reordering
    $tile = [MeetingScreen]::SpeakerTile($bmp, 58, 168)
    $name = $state.speaker
    $due = ((Get-Date) - $state.ocrAt).TotalSeconds -ge 10
    if ($tile) {
      if ($state.tileX -ne $tile[0] -or $due) {
        $name = Ocr ([MeetingScreen]::Crop($bmp, (New-Object System.Drawing.Rectangle ($tile[0] + 3), 138, ($tile[1] - $tile[0] - 6), 26)))
        $state.tileX = $tile[0]; $state.ocrAt = Get-Date
      }
    } elseif (-not $share) {
      if ($state.tileX -ne -1 -or $due) {
        $name = Ocr ([MeetingScreen]::Crop($bmp, (New-Object System.Drawing.Rectangle 0, ($H - 125), 420, 32)))
        $state.tileX = -1; $state.ocrAt = Get-Date
      }
    } else { $name = $null; $state.tileX = $null }
    if ($name -ne $state.speaker) {
      if ($name) { Emit @{ type = 'speaker'; name = $name; how = $(if ($tile) { 'strip outline' } else { 'main label' }) } }
      $state.speaker = $name
    }

    # Frames of the shared screen when its content changes
    if ($share) {
      $area = New-Object System.Drawing.Rectangle 0, 180, $W, ($H - 260)
      $sig = [MeetingScreen]::Signature($bmp, $area)
      $mean = ($sig | Measure-Object -Average).Average
      # Live 21/11: PrintWindow sometimes returns the share area black (Zoom draws it on the GPU). Skip those captures.
      if ($mean -lt 4) { $state.black++; if ($state.black -eq 5) { Emit @{ type = 'frame_unreadable'; by = $state.by; note = 'share area captured black 5 times in a row' } } }
      else { $state.black = 0 }
      $d = if ($mean -lt 4) { 0 } else { [MeetingScreen]::Diff($sig, $state.sig) }
      if ($d -ge $FrameDiff) {
        $file = (Get-Date -Format 'HHmmss') + '.png'
        $bmp.Save((Join-Path $OutDir "frames\$file"), [System.Drawing.Imaging.ImageFormat]::Png)
        Emit @{ type = 'frame'; file = "frames/$file"; by = $state.by; diff = $d }
        $state.sig = $sig
      }
    }
    $bmp.Dispose()
  } catch { Emit @{ type = 'error'; message = $_.Exception.Message } }
  Start-Sleep -Seconds $Interval
}
Emit @{ type = 'end' }
