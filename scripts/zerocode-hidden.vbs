' Runs ZeroCode with no console window and restarts it if it exits.
' Started at logon by the "ZeroCode" shortcut that install.bat puts in the Startup folder.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")

cmd = "cmd /c node """ & root & "\dist\index.js"" >> data\zerocode.log 2>&1"
Do
  sh.Run cmd, 0, True
  WScript.Sleep 5000
Loop
