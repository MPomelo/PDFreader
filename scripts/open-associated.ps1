param([Parameter(Mandatory=$true)][string]$PdfPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PdfreaderAssociation {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Info {
    public int cbSize; public uint fMask; public IntPtr hwnd;
    public string lpVerb; public string lpFile; public string lpParameters;
    public string lpDirectory; public int nShow; public IntPtr hInstApp;
    public IntPtr lpIDList; public string lpClass; public IntPtr hkeyClass;
    public uint dwHotKey; public IntPtr hIcon; public IntPtr hProcess;
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ShellExecuteEx(ref Info info);
  [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static uint Open(string path) {
    var info=new Info {cbSize=Marshal.SizeOf<Info>(),fMask=0x00000141,
      lpVerb="open",lpFile=path,lpClass="PDFreader.PDF",nShow=0};
    if(!ShellExecuteEx(ref info))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    if(info.hProcess==IntPtr.Zero)return 0;
    try{return GetProcessId(info.hProcess);}finally{CloseHandle(info.hProcess);}
  }
}
'@
[PdfreaderAssociation]::Open((Resolve-Path -LiteralPath $PdfPath).Path)
