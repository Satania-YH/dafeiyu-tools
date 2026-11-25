' 澄的记忆星图 · 无痕启动器
' 2026-11-25 爸爸：「一点开就自动启动托盘并打开浏览器」
'
' 为什么用它：powershell.exe 直接跑，Windows 会先画一个控制台窗口再隐藏，
' 那一瞬间的黑框就是闪一下。WScript.Shell.Run 的第 2 个参数 0 = 完全隐藏。

Option Explicit

Dim sh, fso, scriptPath, ps1, cmd, logf

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptPath = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = scriptPath & "\" & ChrW(26143) & ChrW(22270) & ChrW(25176) & ChrW(30424) & ".ps1"

' 调试日志：跑不起来时能看见卡在哪
On Error Resume Next
logf = scriptPath & "\..\data\vbs.log"
Dim ts
Set ts = fso.OpenTextFile(logf, 8, True)
ts.WriteLine "[" & Now & "] scriptPath=" & scriptPath
ts.WriteLine "[" & Now & "] ps1=" & ps1
ts.WriteLine "[" & Now & "] ps1 exists=" & fso.FileExists(ps1)

If Err.Number <> 0 Then
    ts.WriteLine "ERR(early) " & Err.Number & ": " & Err.Description
    Err.Clear
End If

' 用短路径（8.3）绕开中文路径在 sh.Run 里的问题
Dim ps1Short
ps1Short = ps1
If fso.FileExists(ps1) Then
    ps1Short = fso.GetFile(ps1).ShortPath
    ts.WriteLine "[" & Now & "] ps1Short=" & ps1Short
End If
If Err.Number <> 0 Then
    ts.WriteLine "ERR(short) " & Err.Number & ": " & Err.Description
    Err.Clear
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1Short & """ -OpenBrowser"
ts.WriteLine "[" & Now & "] cmd=" & cmd

Dim rc
rc = sh.Run(cmd, 0, False)
ts.WriteLine "[" & Now & "] Run returned rc=" & rc
If Err.Number <> 0 Then
    ts.WriteLine "ERR(run) " & Err.Number & ": " & Err.Description
    Err.Clear
End If

ts.Close
