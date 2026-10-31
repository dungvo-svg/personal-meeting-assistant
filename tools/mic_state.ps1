param([int]$ParentPid = 0, [double]$IntervalSeconds = 1, [switch]$Once)
# Reports, once per interval, whether the owner's microphone is open in a meeting, as one JSON line:
#   {"mic":"on","app":"zoom","by":"uia"}
# mic: on | off | unknown | none
#   on/off   read from the meeting app's own microphone control through Windows UI Automation (by "uia")
#   none     no meeting app holds a capture session on any microphone (by "core-audio")
#   unknown  a meeting app holds the microphone but its control cannot be read (by "core-audio"), or the read failed
# app: zoom | chrome | msedge | ... (the app the answer is about) | none
# Zoom meeting window: the toolbar button "Mute my audio" = on; "Unmute my audio" / "Join Audio" = off.
# Google Meet (a Chrome or Edge window whose title contains "Meet"): the microphone toggle, "Turn off microphone" = on,
#   "Turn on microphone" = off, also "Tắt micrô"/"Bật micrô" and "Tắt micro"/"Bật micro" (the key hint "(ctrl + d)" may follow).
#   If the control has no such verb in its name but exposes TogglePattern, the toggle state is used (On = mic on).
#   NOT VERIFIED against a real meeting: the exact names Meet exposes through UIA need a real Meet to confirm.
# Reads only; never clicks, never changes Zoom, the browser or the audio devices.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Pma {
  [StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Sequential)] public struct PropVariant { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection { int GetCount(out int count); int Item(int index, out IMMDevice device); }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    int OpenPropertyStore(int access, out IPropertyStore store);
  }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { int GetCount(out int count); int GetAt(int index, out PropertyKey key); int GetValue(ref PropertyKey key, out PropVariant value); }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr groupingParam, int flags, out IntPtr control);
    int GetSimpleAudioVolume(IntPtr groupingParam, int flags, out IntPtr volume);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator { int GetCount(out int count); int GetSession(int index, out IAudioSessionControl2 session); }
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out int state);
    int GetDisplayName(out IntPtr name);
    int SetDisplayName(IntPtr name, IntPtr context);
    int GetIconPath(out IntPtr path);
    int SetIconPath(IntPtr path, IntPtr context);
    int GetGroupingParam(out Guid param);
    int SetGroupingParam(IntPtr param, IntPtr context);
    int RegisterAudioSessionNotification(IntPtr client);
    int UnregisterAudioSessionNotification(IntPtr client);
    int GetSessionIdentifier(out IntPtr id);
    int GetSessionInstanceIdentifier(out IntPtr id);
    int GetProcessId(out int pid);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

  public static class CoreAudio {
    // The process IDs, among the given ones, that have an active session on a capture endpoint
    // (eCapture = 1, DEVICE_STATE_ACTIVE = 1).
    public static int[] CapturingProcesses(int[] pids) {
      var found = new List<int>();
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDeviceCollection devices; enumerator.EnumAudioEndpoints(1, 1, out devices);
      int count; devices.GetCount(out count);
      var manager = typeof(IAudioSessionManager2).GUID;
      for (int i = 0; i < count; i++) {
        IMMDevice device; devices.Item(i, out device);
        object instance; if (device.Activate(ref manager, 23, IntPtr.Zero, out instance) != 0) continue;
        IAudioSessionEnumerator sessions; ((IAudioSessionManager2)instance).GetSessionEnumerator(out sessions);
        int n; sessions.GetCount(out n);
        for (int j = 0; j < n; j++) {
          IAudioSessionControl2 session; sessions.GetSession(j, out session);
          int pid, state; session.GetProcessId(out pid); session.GetState(out state);
          if (state == 1 && Array.IndexOf(pids, pid) >= 0 && !found.Contains(pid)) found.Add(pid);
        }
      }
      return found.ToArray();
    }
  }
}
'@

$MeetingApps = @('zoom', 'chrome', 'msedge', 'firefox', 'brave', 'opera', 'ms-teams', 'teams', 'slack')
$UIA = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$buttons = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
  (New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::CheckBox)))
$anything = [System.Windows.Automation.Condition]::TrueCondition
$root = $UIA::RootElement

# Zoom's toolbar offers the opposite action: "Unmute…" while muted, "Mute…" while the mic is on. The exact toolbar names come
# first; a looser prefix match (0.9.0 behaviour) only if none was found. "Mute All" (host) is never the owner's mic.
$ZoomOffExact = '^(unmute my audio|join audio)'
$ZoomOnExact = '^mute my audio'
$ZoomOffLoose = '^(unmute|join audio|bật tiếng|tham gia âm thanh)'
$ZoomOnLoose = '^(mute|tắt tiếng)'
# Meet: the name says what a click does, so "Turn off microphone" means the mic is on now.
$MeetOn = '^(turn off (your )?(microphone|mic)|tắt (micrô|micro|mic))'
$MeetOff = '^(turn on (your )?(microphone|mic)|bật (micrô|micro|mic))'
$MeetMic = '(microphone|micrô|micro\b)'

function Window-Of([int[]]$pids) {
  foreach ($w in $root.FindAll($Scope::Children, $anything)) { if ($pids -contains $w.Current.ProcessId) { $w } }
}

function Read-Zoom {
  $zoom = @(Get-Process Zoom -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if (-not $zoom.Count) { return $null }
  $names = @()
  foreach ($window in @(Window-Of $zoom)) {
    foreach ($b in $window.FindAll($Scope::Descendants, $buttons)) {
      $name = ([string]$b.Current.Name).Trim()
      if ($name -and $name -notmatch '(?i)\ball\b|tất cả|everyone|mọi người') { $names += $name }
    }
  }
  foreach ($name in $names) { if ($name -match "(?i)$ZoomOffExact") { return 'off' }; if ($name -match "(?i)$ZoomOnExact") { return 'on' } }
  foreach ($name in $names) { if ($name -match "(?i)$ZoomOffLoose") { return 'off' }; if ($name -match "(?i)$ZoomOnLoose") { return 'on' } }
  return $null
}

function Read-Meet([string]$process) {
  $pids = @(Get-Process $process -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if (-not $pids.Count) { return $null }
  foreach ($window in @(Window-Of $pids)) {
    if ([string]$window.Current.Name -notmatch 'Meet') { continue }
    foreach ($b in $window.FindAll($Scope::Descendants, $buttons)) {
      $name = ([string]$b.Current.Name).Trim()
      if ($name -match "(?i)$MeetOn") { return 'on' }
      if ($name -match "(?i)$MeetOff") { return 'off' }
      if ($name -match "(?i)$MeetMic" -and $name -notmatch '(?i)camera|máy ảnh') {
        $pattern = $null
        if ($b.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
          return $(if ($pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { 'on' } else { 'off' })
        }
      }
    }
  }
  return $null
}

function Read-State {
  $state = Read-Zoom
  if ($state) { return [ordered]@{ mic = $state; app = 'zoom'; by = 'uia' } }
  foreach ($browser in 'chrome', 'msedge') {
    $state = Read-Meet $browser
    if ($state) { return [ordered]@{ mic = $state; app = $browser; by = 'uia' } }
  }
  # Nothing readable: is any meeting app holding a microphone at all?
  $owners = @{}
  foreach ($p in @(Get-Process -Name $MeetingApps -ErrorAction SilentlyContinue)) { $owners[[int]$p.Id] = $p.ProcessName }
  if ($owners.Count) {
    $holding = @([Pma.CoreAudio]::CapturingProcesses([int[]]@($owners.Keys)))
    if ($holding.Count) { return [ordered]@{ mic = 'unknown'; app = $owners[[int]$holding[0]]; by = 'core-audio' } }
  }
  return [ordered]@{ mic = 'none'; app = 'none'; by = 'core-audio' }
}

do {
  $started = [Diagnostics.Stopwatch]::StartNew()
  if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  try { $line = Read-State | ConvertTo-Json -Compress } catch { $line = ([ordered]@{ mic = 'unknown'; app = 'none'; by = 'uia'; error = $_.Exception.Message } | ConvertTo-Json -Compress) }
  [Console]::Out.WriteLine($line); [Console]::Out.Flush()
  if (-not $Once) { Start-Sleep -Milliseconds ([Math]::Max(50, [int]($IntervalSeconds * 1000 - $started.ElapsedMilliseconds))) }
} while (-not $Once)
