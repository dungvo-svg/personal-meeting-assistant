@echo off
setlocal
cd /d "%~dp0"
echo Personal Meeting Assistant - complete local Claude setup
echo First fully quit Claude Desktop using its Quit command.
echo This helper will not close Claude or start audio capture.
"%~dp0.venv\Scripts\python.exe" "%~dp0tools\install_claude.py" --config "%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude_desktop_config.json" --node "D:\APP\NodeJS\node.exe" --apply
if errorlevel 1 goto failed
echo.
echo Config saved and read back. Now open Claude Desktop yourself.
echo Then open http://127.0.0.1:8796/ and follow the local meeting runbook.
pause
exit /b 0
:failed
echo.
echo Setup did not complete. Read the message above. No capture was started.
pause
exit /b 1
