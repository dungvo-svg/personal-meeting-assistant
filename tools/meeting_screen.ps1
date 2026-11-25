<#
.SYNOPSIS
  Watch the Zoom meeting window, or the Google Meet tab in Chrome/Edge (read only), and write what the screen shows: who is
  sharing and when, who is marked as speaking, and one frame of the shared screen each time its content changes.
  -Mode auto|zoom|meet picks the app (auto: whichever window is open, Zoom first). Meet: window titled "Meet - ..."; the
  presenter comes from UI Automation names ("<name> is presenting", Vietnamese, Lao); frames are the presentation area only;
  when that area stays blank or covered, a screen_hidden event (MAN HINH AN) is written instead of blank images.
  Meet, for who is speaking (0.13.8): page text that is new since the last tick (captions with the speaker's name when the owner
  turns captions on, chat messages, join notices) goes to <OutDir>/meet_text.jsonl, and a JPEG of the page every -TileSeconds
  goes to <OutDir>/frames/meet/HHmmss.jpg. Both stay on this machine.

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
  [string]$OutDir,
  [double]$Interval = 2,
  [int]$FrameDiff = 12,     # mean absolute grey difference (0-255) that counts as new shared content
  [int]$MaxMinutes = 0,     # 0 = until stopped
  [int]$IdleExitMinutes = 15,  # no meeting window this long = the meeting is over: exit
  [ValidateSet('auto', 'zoom', 'meet')][string]$Mode = 'auto',  # which meeting window to watch; auto = whichever is open (Zoom first when both)
  [int]$HiddenTicks = 3,    # Meet: this many flat presentation areas in a row = MAN HINH AN (screen_hidden)
  [double]$TileSeconds = 3, # Meet: a picture of the whole page (tiles, captions) every this many seconds, for who is speaking; 0 = off
  [switch]$Library          # define the pure decision functions and return (tests dot-source the script with this)
)
$ErrorActionPreference = 'Stop'

# ---- Pure decisions (no window, no screen, no files): tested with synthetic fixtures in tests/screen_meet.test.mjs ----
# Source stays ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI): non-ASCII letters are \uXXXX regex escapes.

# Meet's window title is "Meet - <code or meeting name>" (Chrome adds " - Google Chrome", Edge " - Microsoft Edge"). The Meet home
# page is "Google Meet" and does not count. Only the active tab names the window, so the Meet tab must be the one showing.
function Test-MeetTitle([string]$title) {
  if (-not $title) { return $false }
  return $title.Normalize([Text.NormalizationForm]::FormC) -match '^Meet\s+[-\u2013\u2014]\s*\S'
}

# Which window to watch. $candidates: objects with kind ('zoom'|'meet'), minimized, area. -Mode forces a kind; auto keeps the kind
# used last tick when both are open, else Zoom (so the Zoom behaviour is unchanged). Within a kind: a visible window first, then the biggest.
function Select-MeetingWindow($candidates, [string]$mode, [string]$previous) {
  $list = @($candidates | Where-Object { $_ -and ($mode -eq 'auto' -or $_.kind -eq $mode) })
  if (-not $list.Count) { return $null }
  $kinds = @($list | ForEach-Object { $_.kind } | Select-Object -Unique)
  $kind = if ($kinds.Count -eq 1) { $kinds[0] } elseif ($previous -in $kinds) { $previous } else { 'zoom' }
  return @($list | Where-Object { $_.kind -eq $kind } | Sort-Object @{ Expression = { [bool]$_.minimized } }, @{ Expression = { -[double]$_.area } })[0]
}

# "<name> is presenting" and the like, from one UI Automation name. Returns @{ by; self } or $null. English and Vietnamese; the Lao
# strings are a best guess (not yet seen on a real Lao-UI meeting).
$script:PresentSelf = @(
  '^You(?:\u2019|'')?(?:re| are) presenting',
  '^B\u1ea1n \u0111ang tr\u00ecnh (?:b\u00e0y|chi\u1ebfu)',
  '^\u0e81\u0eb3\u0ea5\u0eb1\u0e87\u0e99\u0eb3\u0eaa\u0eb0\u0ec0\u0edc\u0eb5'
)
$script:PresentOther = @(
  '^(?<n>.+?) (?:is|are) presenting',
  '^(?<n>.+?)(?:\u2019|'')s presentation',
  '^Presentation (?:from|by) (?<n>.+)$',
  '^(?<n>.+?) \u0111ang tr\u00ecnh (?:b\u00e0y|chi\u1ebfu)',
  '^B\u1ea3n tr\u00ecnh b\u00e0y c\u1ee7a (?<n>.+)$',
  '^(?<n>.+?) \u0e81\u0eb3\u0ea5\u0eb1\u0e87\u0e99\u0eb3\u0eaa\u0eb0\u0ec0\u0edc\u0eb5',
  '^\u0e81\u0eb2\u0e99\u0e99\u0eb3\u0eaa\u0eb0\u0ec0\u0edc\u0eb5\u0e82\u0ead\u0e87 (?<n>.+)$'
)
function ConvertFrom-PresenterText([string]$text) {
  if (-not $text) { return $null }
  $t = $text.Normalize([Text.NormalizationForm]::FormC).Trim()
  foreach ($p in $script:PresentSelf) { if ($t -match $p) { return @{ by = $null; self = $true } } }
  foreach ($p in $script:PresentOther) {
    if ($t -match $p) {
      $n = ($Matches['n'] -replace '\s*\((?:You|B\u1ea1n|T\u00f4i)\)\s*$', '').Trim(' ', '.', ',', ':')
      if ($n.Length -ge 2 -and $n.Length -le 80) { return @{ by = $n; self = $false } }
    }
  }
  return $null
}

# Everything the meeting page's UI Automation tree names, reduced to what the watcher needs: is someone presenting and who, is a side
# panel (People) open, who the page marks as speaking (only if Meet exposes it; not seen yet).
function Get-MeetObservation($names) {
  $obs = @{ presenting = $false; by = $null; self = $false; panel = $false; speaker = $null }
  foreach ($raw in @($names)) {
    if (-not $raw) { continue }
    $n = ([string]$raw).Normalize([Text.NormalizationForm]::FormC).Trim()
    if (-not $n -or $n.Length -gt 200) { continue }
    if (-not $obs.presenting) {
      $p = ConvertFrom-PresenterText $n
      if ($p) { $obs.presenting = $true; $obs.by = $p.by; $obs.self = $p.self }
    }
    if ($n -imatch '^(?:People|M\u1ecdi ng\u01b0\u1eddi)$') { $obs.panel = $true }
    if (-not $obs.speaker -and $n -imatch '^(?<n>.+?) (?:is speaking|\u0111ang n\u00f3i|\u0e81\u0eb3\u0ea5\u0eb1\u0e87\u0ec0\u0ea7\u0ebb\u0ec9\u0eb2)$') { $obs.speaker = $Matches['n'].Trim() }
  }
  return $obs
}

# Where the presentation shows: the page (below the browser bars) without the bottom control bar, and without the right side panel
# when it is open. $page = @{ x; y; w; h } relative to the window, or $null when unknown (fixed browser-bar height then).
function Get-PresentationArea($page, [int]$winW, [int]$winH, [bool]$panelOpen) {
  $x = 0; $y = 120; $w = $winW; $h = $winH - 120
  if ($page -and $page.w -gt 200 -and $page.h -gt 200 -and $page.x -ge 0 -and $page.y -ge 0 -and ($page.x + $page.w) -le ($winW + 2) -and ($page.y + $page.h) -le ($winH + 2)) {
    $x = [int]$page.x; $y = [int]$page.y; $w = [int]$page.w; $h = [int]$page.h
  }
  $h -= 96                      # Meet's bottom control bar
  if ($panelOpen) { $w -= 392 } # side panel (People, Chat): 360 px plus margins
  if ($w -lt 100 -or $h -lt 100) { return $null }
  return @{ x = $x; y = $y; w = $w; h = $h }
}

# Grey signatures are 32x18 byte arrays (MeetingScreen.Signature). Flat = nothing drawn there: Meet's empty dark area, or the
# presentation covered. Measured as the standard deviation, so any flat colour counts, not only black.
function Get-SigStats($sig) {
  if (-not $sig -or -not $sig.Length) { return @{ mean = 0.0; sd = 0.0 } }
  $m = ($sig | Measure-Object -Average).Average
  $v = 0.0; foreach ($b in $sig) { $v += ($b - $m) * ($b - $m) }
  return @{ mean = [double]$m; sd = [math]::Sqrt($v / $sig.Length) }
}
function Test-SigFlat($sig, [double]$maxSd = 3) { return (Get-SigStats $sig).sd -lt $maxSd }
function Get-SigDiff($a, $b) {
  if (-not $a -or -not $b -or $a.Length -ne $b.Length) { return 255 }
  $t = 0L; for ($i = 0; $i -lt $a.Length; $i++) { $t += [math]::Abs([int]$a[$i] - [int]$b[$i]) }
  return [int][math]::Floor($t / $a.Length)
}

# One tick of the Meet watcher. $state: share, by, self, sig, hidden, flat, speaker. $obs: Get-MeetObservation plus sig (signature of the
# presentation area, $null when it could not be read). Returns the new state and the events to emit; a 'frame' event has no file yet
# (the caller saves the area image and sets it). A presenter change emits share_stop then share_start. Nothing is saved while the
# area is flat: screen_hidden (MAN HINH AN) once after $hiddenTicks flat ticks in a row, screen_visible when it draws again. Own
# share: Meet shows only a placeholder, so no frames and no hidden verdict.
function New-MeetState { return @{ share = $false; by = $null; self = $false; sig = $null; hidden = $false; flat = 0; speaker = $null } }
function Get-PresenterKey($by, $self) { if ($self) { return '#self' } elseif ($by) { return ([string]$by).ToLowerInvariant() } else { return $null } }
function Step-MeetState($state, $obs, [int]$frameDiff = 12, [int]$hiddenTicks = 3) {
  $s = @{} + $state
  $events = New-Object System.Collections.ArrayList
  if ($obs.presenting) {
    $oldKey = Get-PresenterKey $s.by $s.self; $newKey = Get-PresenterKey $obs.by $obs.self
    if ($s.share -and $oldKey -and $newKey -and $oldKey -ne $newKey) {
      [void]$events.Add(@{ type = 'share_stop'; by = $s.by; self = $s.self; reason = 'presenter changed' })
      $s.share = $false
    }
    if (-not $s.share) {
      [void]$events.Add(@{ type = 'share_start'; by = $obs.by; self = $obs.self; app = 'meet'; panel = $obs.panel })
      $s.share = $true; $s.sig = $null; $s.hidden = $false; $s.flat = 0
    }
    if ($obs.by -or $obs.self) { $s.by = $obs.by; $s.self = $obs.self }  # a name read late fills in; an unread name never erases one
  } elseif ($s.share) {
    [void]$events.Add(@{ type = 'share_stop'; by = $s.by; self = $s.self })
    $s.share = $false; $s.by = $null; $s.self = $false; $s.sig = $null; $s.hidden = $false; $s.flat = 0
  }
  if ($s.share -and -not $s.self -and $obs.sig) {
    if (Test-SigFlat $obs.sig) {
      $s.flat++
      if ($s.flat -ge $hiddenTicks -and -not $s.hidden) {
        $s.hidden = $true
        $why = if ($obs.panel) { 'side panel open over the presentation' } else { 'presentation area is blank' }
        [void]$events.Add(@{ type = 'screen_hidden'; by = $s.by; reason = $why; panel = [bool]$obs.panel })
      }
    } else {
      $s.flat = 0
      if ($s.hidden) { [void]$events.Add(@{ type = 'screen_visible'; by = $s.by }); $s.hidden = $false }
      $d = Get-SigDiff $obs.sig $s.sig
      if ($d -ge $frameDiff) { [void]$events.Add(@{ type = 'frame'; by = $s.by; diff = $d }); $s.sig = $obs.sig }
    }
  }
  if ($obs.speaker -ne $s.speaker) {
    if ($obs.speaker) { [void]$events.Add(@{ type = 'speaker'; name = $obs.speaker; how = 'meet ui automation' }) }
    $s.speaker = $obs.speaker
  }
  return @{ state = $s; events = @($events) }
}

# Meet text log (0.13.8, owner 25/11: catch who is speaking). Meet does not mark the speaker in a way read so far, but with the
# owner's captions on, each caption shows the speaker's name above the words; chat messages and "X joined" notices also appear as
# page text. Each tick keeps only the strings that were not on the page the tick before (tile names, buttons and menus stay the
# same, so they are logged once). Each new string carries the string just before it on the page ("before"): for a caption that is
# the speaker's name, which is on the page all the time as a tile name and so never new itself (smoke run 25/11 lost Ms Tar that
# way). $prev: the previous tick's strings (array or $null). Returns @{ new = @{ text; before } in page order; seen = this tick's
# strings }. Blank strings are dropped, long ones cut to $maxLen, at most $max per tick.
function Get-NewMeetTexts($names, $prev, [int]$max = 80, [int]$maxLen = 300) {
  $seenSet = New-Object 'System.Collections.Generic.HashSet[string]'
  $prevSet = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($p in @($prev)) { if ($p) { [void]$prevSet.Add([string]$p) } }
  $new = New-Object System.Collections.ArrayList
  $cut = { param($s) if ($s.Length -gt $maxLen) { $s.Substring(0, $maxLen) } else { $s } }
  $last = $null
  foreach ($n in @($names)) {
    if (-not $n) { continue }
    $t = ([string]$n).Trim()
    if ($t.Length -lt 2) { continue }
    if ($seenSet.Add($t) -and -not $prevSet.Contains($t) -and $new.Count -lt $max) {
      [void]$new.Add([ordered]@{ text = (& $cut $t); before = $(if ($last) { & $cut $last } else { $null }) })
    }
    $last = $t
  }
  return @{ new = @($new); seen = @($seenSet) }
}

if ($Library) { return }
if (-not $OutDir) { throw 'OutDir is required' }
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
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  // Chrome and Edge top-level windows: {handle, title, minimized, area}. The caller keeps the ones titled "Meet - ...".
  public static System.Collections.Generic.List<object[]> BrowserWindows() {
    var list = new System.Collections.Generic.List<object[]>();
    EnumWindows((h, l) => { var c = new StringBuilder(128); GetClassName(h, c, 128);
      if (c.ToString() == "Chrome_WidgetWin_1" && IsWindowVisible(h)) {
        var t = new StringBuilder(512); GetWindowText(h, t, 512); RECT r; GetWindowRect(h, out r);
        if (t.Length > 0) list.Add(new object[] { h, t.ToString(), IsIconic(h), (double)Math.Max(0, r.R - r.L) * Math.Max(0, r.B - r.T) });
      } return true; }, IntPtr.Zero);
    return list;
  }
  public static int[] WindowRect(IntPtr h) { RECT r; GetWindowRect(h, out r); return new int[] { r.L, r.T, r.R, r.B }; }
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
# Vietnamese names keep their marks only with the Vietnamese OCR pack (Windows Settings > Language > Vietnamese); live 21/11 the
# en-US engine read "Mr \u0110\u1ee9c - NNC H\u00e0 N\u1ed9i" as "Mr Dirc - NNC H\u00e5 N\u00f6i".
$vi = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Where-Object { $_.LanguageTag -like 'vi*' } | Select-Object -First 1
$engine = if ($vi) { [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($vi) } else { [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
$ocrLanguage = if ($vi) { $vi.LanguageTag } else { 'en-US (t\u00ean ti\u1ebfng Vi\u1ec7t m\u1ea5t d\u1ea5u)' }
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

# ---- Google Meet (Chrome/Edge tab titled "Meet - ..."): the thin, impure part. Decisions are the pure functions above. ----
# Every UI Automation name on the meeting page (Chrome builds this tree once an automation client asks, so the first ticks can be empty).
function Get-MeetNames($hwnd) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $cr = New-Object System.Windows.Automation.CacheRequest
  $cr.Add([System.Windows.Automation.AutomationElement]::NameProperty)
  $scope = $cr.Activate()
  try { return @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Cached.Name }) }
  finally { $scope.Dispose() }
}
# The web page (document) rectangle relative to the window, to know where the browser bars end; $null when not readable.
function Get-MeetPage($hwnd) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
    $doc = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if (-not $doc) { return $null }
    $r = $doc.Current.BoundingRectangle; $w = [MeetingScreen]::WindowRect($hwnd)
    if ($r.IsEmpty) { return $null }
    return @{ x = [int]($r.X - $w[0]); y = [int]($r.Y - $w[1]); w = [int]$r.Width; h = [int]$r.Height }
  } catch { return $null }
}
$meet = New-MeetState; $meetWindow = $null; $meetPrevTexts = $null; $tileAt = [datetime]::MinValue
$meetTextLog = Join-Path $OutDir 'meet_text.jsonl'
New-Item -ItemType Directory -Force (Join-Path $OutDir 'frames\meet') | Out-Null
# JPEG encoder for the page pictures (small files: one every few seconds for the whole meeting)
$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$jpegParams = New-Object System.Drawing.Imaging.EncoderParameters 1
$jpegParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]70)
function Save-MeetTile($bmp, $hwnd) {
  # The web page only (no browser bars), scaled to at most 1280 px wide; named by local time so it lines up with the transcript.
  $page = Get-MeetPage $hwnd
  $r = if ($page) { New-Object System.Drawing.Rectangle $page.x, $page.y, $page.w, $page.h } else { New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height }
  $crop = [MeetingScreen]::Crop($bmp, $r)
  if (-not $crop) { return }
  try {
    $scale = [Math]::Min(1.0, 1280.0 / $crop.Width)
    $small = New-Object System.Drawing.Bitmap ([int]($crop.Width * $scale)), ([int]($crop.Height * $scale))
    $g = [System.Drawing.Graphics]::FromImage($small); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($crop, 0, 0, $small.Width, $small.Height); $g.Dispose()
    $small.Save((Join-Path $OutDir ("frames\meet\" + (Get-Date -Format 'HHmmss') + '.jpg')), $jpegCodec, $jpegParams); $small.Dispose()
  } finally { $crop.Dispose() }
}
function Invoke-MeetTick($pick) {
  $label = if ($pick.minimized) { 'minimized' } else { 'visible' }
  if ($label -ne $script:meetWindow) { Emit @{ type = 'meet_window'; window = $label; title = $pick.title }; $script:meetWindow = $label }
  if ($pick.minimized) { return }   # a minimized window cannot be captured; the UI tree is not trusted either
  $names = Get-MeetNames $pick.hwnd
  # New page text (captions with the speaker's name, chat, join notices) goes to meet_text.jsonl, not to screen.jsonl: it is
  # read by the central session for names, it does not become a line of its own in the transcript.
  $texts = Get-NewMeetTexts $names $script:meetPrevTexts
  $script:meetPrevTexts = $texts.seen
  if ($texts.new.Count -gt 0) {
    $now = Get-Date
    $o = [ordered]@{ at = $now.ToString('HH:mm:ss'); utc = $now.ToUniversalTime().ToString('o'); texts = @($texts.new) }
    Add-Content -Encoding utf8 $meetTextLog ($o | ConvertTo-Json -Compress)
  }
  $obs = Get-MeetObservation $names
  $bmp = $null; $rect = $null
  try {
    if ($TileSeconds -gt 0 -and ((Get-Date) - $script:tileAt).TotalSeconds -ge $TileSeconds) {
      $script:tileAt = Get-Date
      $bmp = [MeetingScreen]::Capture($pick.hwnd)
      if ($bmp) { try { Save-MeetTile $bmp $pick.hwnd } catch { Emit @{ type = 'error'; message = 'meet tile: ' + $_.Exception.Message } } }
    }
    if ($obs.presenting -and -not $obs.self) {
      if (-not $bmp) { $bmp = [MeetingScreen]::Capture($pick.hwnd) }
      if ($bmp) {
        $a = Get-PresentationArea (Get-MeetPage $pick.hwnd) $bmp.Width $bmp.Height $obs.panel
        if ($a) {
          $rect = New-Object System.Drawing.Rectangle $a.x, $a.y, $a.w, $a.h
          $rect.Intersect((New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height))
          $obs.sig = [MeetingScreen]::Signature($bmp, $rect)
        }
      }
    }
    $step = Step-MeetState $script:meet $obs $FrameDiff $HiddenTicks
    $script:meet = $step.state
    foreach ($ev in $step.events) {
      if ($ev.type -eq 'frame') {
        $crop = if ($bmp -and $rect) { [MeetingScreen]::Crop($bmp, $rect) } else { $null }
        if (-not $crop) { continue }
        $file = (Get-Date -Format 'HHmmss') + '.png'
        $crop.Save((Join-Path $OutDir "frames\$file"), [System.Drawing.Imaging.ImageFormat]::Png); $crop.Dispose()
        $ev.file = "frames/$file"
      }
      Emit $ev
    }
  } finally { if ($bmp) { $bmp.Dispose() } }
}

$state = @{ zoom = $null; share = $false; by = $null; speaker = $null; sig = $null; tileX = $null; ocrAt = [datetime]::MinValue; black = 0 }
$started = Get-Date; $lastSeen = Get-Date; $prevKind = $null
Emit @{ type = 'start'; interval = $Interval; out = $OutDir; ocr = $ocrLanguage; mode = $Mode }
while ($MaxMinutes -le 0 -or ((Get-Date) - $started).TotalMinutes -lt $MaxMinutes) {
  try {
    $cands = @()
    if ($Mode -ne 'meet') {
      $zh = [MeetingScreen]::FindMeeting()
      if ($zh -ne [IntPtr]::Zero) { $cands += [pscustomobject]@{ kind = 'zoom'; hwnd = $zh; minimized = [MeetingScreen]::Minimized($zh); area = 0; title = '' } }
    }
    if ($Mode -ne 'zoom') {
      foreach ($w in [MeetingScreen]::BrowserWindows()) { if (Test-MeetTitle $w[1]) { $cands += [pscustomobject]@{ kind = 'meet'; hwnd = $w[0]; title = $w[1]; minimized = [bool]$w[2]; area = $w[3] } } }
    }
    $pick = Select-MeetingWindow $cands $Mode $prevKind
    $kind = if ($pick) { $pick.kind } else { $null }
    if ($prevKind -eq 'meet' -and $kind -ne 'meet') {
      # Left Meet (closed, or switched to Zoom): close its share and forget the window state
      if ($meet.share) { Emit @{ type = 'share_stop'; by = $meet.by; self = $meet.self; reason = 'no meeting window' } }
      if (-not $kind) { Emit @{ type = 'meet_window'; window = 'none' } }
      $meet = New-MeetState; $meetWindow = $null
    }
    if ($kind) { $prevKind = $kind }
    if ($kind -eq 'meet') {
      $lastSeen = Get-Date
      Invoke-MeetTick $pick
      Start-Sleep -Seconds $Interval; continue
    }
    $h = if ($pick) { $pick.hwnd } else { [IntPtr]::Zero }
    $zoom = if ($h -eq [IntPtr]::Zero) { 'none' } elseif ([MeetingScreen]::Minimized($h)) { 'minimized' } else { 'visible' }
    if ($zoom -ne $state.zoom) { if ($Mode -ne 'meet') { Emit @{ type = 'zoom'; window = $zoom } }; $state.zoom = $zoom }
    if ($zoom -ne 'none') { $lastSeen = Get-Date }
    elseif (((Get-Date) - $lastSeen).TotalMinutes -ge $IdleExitMinutes) { Emit @{ type = 'end'; reason = "no meeting window for $IdleExitMinutes min" }; exit 0 }
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
      $by = if ($tab -match "^(.+?)['\u2019]s screen") { $Matches[1].Trim() } else { $null }
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
