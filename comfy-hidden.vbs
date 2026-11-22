Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\ComfyUI\ComfyUI_windows_portable"
sh.Run "cmd /c python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build > E:\ComfyUI\comfy_out.log 2>&1", 0, False
