param([int]$AppProcessId, [string]$TargetPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PdfreaderSaveControl {
 public delegate bool EnumProc(IntPtr handle, IntPtr parameter);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr handle);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder name, int count);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, string text);
 public static string Dump(IntPtr dialog) {
  var result=new StringBuilder();
  EnumChildWindows(dialog,(handle,parameter)=>{var name=new StringBuilder(128);GetClassName(handle,name,128);if(name.ToString().Contains("Edit")||name.ToString().Contains("Combo")||GetDlgCtrlID(handle)==1001)result.AppendLine(GetDlgCtrlID(handle)+" "+name.ToString());return true;},IntPtr.Zero);
  return result.ToString();
 }
 public static IntPtr FindFilename(IntPtr dialog) {
  IntPtr result = IntPtr.Zero;
  EnumChildWindows(dialog, (handle, parameter) => {
   var name=new StringBuilder(128); GetClassName(handle,name,128);
   if((GetDlgCtrlID(handle)==1001 || GetDlgCtrlID(handle)==1148) && name.ToString()=="Edit") { result=handle; return false; }
   return true;
  },IntPtr.Zero);
  return result;
 }
 public static IntPtr FindSave(IntPtr dialog) {
  IntPtr result = IntPtr.Zero;
  EnumChildWindows(dialog, (handle, parameter) => {
   var name=new StringBuilder(128); GetClassName(handle,name,128);
   if(GetDlgCtrlID(handle)==1 && name.ToString()=="Button") { result=handle; return false; }
   return true;
  },IntPtr.Zero);
  return result;
 }
}
'@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $AppProcessId)
$deadline = [DateTime]::UtcNow.AddSeconds(12)
$edit = $null
$dialog = $null
$diagnostics = @()
$nativeEdit = [IntPtr]::Zero
while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)) {
        if ($window.Current.ClassName -ne '#32770') { continue }
        [PdfreaderSaveControl]::Dump([IntPtr]$window.Current.NativeWindowHandle) | Set-Content -LiteralPath (Join-Path $PSScriptRoot '../test-results/stage05/dialog-native-controls.txt') -Encoding UTF8
        $nativeEdit = [PdfreaderSaveControl]::FindFilename([IntPtr]$window.Current.NativeWindowHandle)
        if ($nativeEdit -ne [IntPtr]::Zero) { $dialog = $window; break }
        $editCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
        foreach ($candidate in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition)) {
            if (-not $candidate.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty)) { continue }
            $pattern = $candidate.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $diagnostics += @{ name = $candidate.Current.Name; id = $candidate.Current.AutomationId; value = $pattern.Current.Value }
            if ($candidate.Current.AutomationId -eq '1001' -or $candidate.Current.Name -match '文件名|File name' -or $pattern.Current.Value -match 'PDFreader|\.md$') { $edit = $candidate; $dialog = $window; break }
        }
        if ($edit) { break }
    }
    if ($edit -or $nativeEdit -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 150
}
if ($nativeEdit -ne [IntPtr]::Zero) {
    [void][PdfreaderSaveControl]::SendMessage($nativeEdit, 12, [IntPtr]::Zero, $TargetPath)
} elseif ($edit) {
    $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value.SetValue($TargetPath)
} else { $diagnostics | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path (Split-Path $TargetPath) 'native-save-controls.json') -Encoding UTF8; throw 'Native save filename control not found; control diagnostics saved' }
$nativeSave = [PdfreaderSaveControl]::FindSave([IntPtr]$dialog.Current.NativeWindowHandle)
if ($nativeSave -eq [IntPtr]::Zero) { throw 'Native save button not found' }
[void][PdfreaderSaveControl]::SendMessage($nativeSave, 245, [IntPtr]::Zero, $null)
Write-Output 'Completed the native file dialog'
