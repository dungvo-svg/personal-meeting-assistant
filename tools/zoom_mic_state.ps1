param([int]$ParentPid = 0, [double]$IntervalSeconds = 1, [switch]$Once)
# Reports, once per interval, whether the user's Zoom microphone is on, as one JSON line:
#   {"meeting":true,"muted":false,"device":"Microphone (Realtek(R) Audio)"}
# muted: from the meeting toolbar button name read through Windows UI Automation ("Mute my audio" = mic on,
# "Unmute my audio" = mic off); null when no meeting window or the button cannot be read. The caller treats null as off.
# device: the capture endpoint where Zoom.exe holds an active audio session (Windows Core Audio), or null.
# Reads only; never clicks, never changes Zoom or the audio devices.
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
    // Capture endpoints (eCapture = 1, DEVICE_STATE_ACTIVE = 1) on which one of the given processes has an active session.
    public static string[] CaptureDevicesUsedBy(int[] pids) {
      var found = new List<string>();
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
          if (state == 1 && Array.IndexOf(pids, pid) >= 0) { found.Add(Name(device)); break; }
        }
      }
      return found.ToArray();
    }
    static string Name(IMMDevice device) {
      IPropertyStore store; device.OpenPropertyStore(0, out store);
      var key = new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
      PropVariant value; store.GetValue(ref key, out value);
      return value.vt == 31 ? Marshal.PtrToStringUni(value.p) : null;
    }
  }
}
'@

$button = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$all = [System.Windows.Automation.Condition]::TrueCondition
$root = [System.Windows.Automation.AutomationElement]::RootElement

function Read-State {
  $zoom = @(Get-Process Zoom -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $state = [ordered]@{ meeting = $false; muted = $null; device = $null }
  if (-not $zoom.Count) { return $state }
  try { $state.device = @([Pma.CoreAudio]::CaptureDevicesUsedBy([int[]]$zoom))[0] } catch { }
  foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $all)) {
    if ($zoom -notcontains $window.Current.ProcessId) { continue }
    foreach ($b in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $button)) {
      $name = $b.Current.Name
      # The button offers the opposite action: "Unmute…" while muted, "Mute…" while the mic is on.
      if ($name -match '^(?i)(unmute|bật tiếng|join audio|tham gia âm thanh)') { $state.meeting = $true; $state.muted = $true; return $state }
      if ($name -match '^(?i)(mute|tắt tiếng)') { $state.meeting = $true; $state.muted = $false; return $state }
    }
  }
  return $state
}

do {
  if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  try { $line = Read-State | ConvertTo-Json -Compress } catch { $line = (@{ meeting = $false; muted = $null; device = $null; error = $_.Exception.Message } | ConvertTo-Json -Compress) }
  [Console]::Out.WriteLine($line); [Console]::Out.Flush()
  if (-not $Once) { Start-Sleep -Milliseconds ([int]($IntervalSeconds * 1000)) }
} while (-not $Once)
