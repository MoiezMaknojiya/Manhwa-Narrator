# Native Windows "choose folder" dialog. Server (POST /api/pick-folder) ise spawn karta hai;
# chosen path stdout par aata hai, cancel = kuch nahi. Modern IFileOpenDialog (FOS_PICKFOLDERS) use hota hai,
# agar wo compile na ho to classic FolderBrowserDialog fallback. Owner form TopMost hai taake dialog browser ke upar aaye.
param([string]$Start = '', [string]$Title = 'Choose a folder')
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Runtime.InteropServices;
public static class SarFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW { }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, uint fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
  public static string Pick(string title, string start, IntPtr owner) {
    var dlg = (IFileDialog)new FileOpenDialogRCW();
    uint opts; dlg.GetOptions(out opts);
    dlg.SetOptions(opts | 0x20u | 0x40u | 0x8u); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR
    dlg.SetTitle(title);
    dlg.SetOkButtonLabel("Select folder");
    if (!string.IsNullOrEmpty(start) && System.IO.Directory.Exists(start)) {
      try { Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"); IShellItem it; SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out it); dlg.SetFolder(it); } catch { }
    }
    if (dlg.Show(owner) != 0) return null; // cancelled
    IShellItem res; dlg.GetResult(out res);
    string path; res.GetDisplayName(0x80058000u, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
'@

$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.FormBorderStyle = 'None'; $owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'; $owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show(); $owner.Activate()
$path = $null
try {
  Add-Type -TypeDefinition $src -ErrorAction Stop
  $path = [SarFolderPicker]::Pick($Title, $Start, $owner.Handle)
} catch {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $Title; $d.ShowNewFolderButton = $true
  if ($Start -and (Test-Path -LiteralPath $Start)) { $d.SelectedPath = $Start }
  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $path = $d.SelectedPath }
}
$owner.Close()
if ($path) { Write-Output $path }
