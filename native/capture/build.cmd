@echo off
rem Builds syncwave-capture.exe with the MSVC toolchain (VS Build Tools 2019+).
rem Output: resources\bin\syncwave-capture.exe
setlocal
set "ROOT=%~dp0..\.."
set "OUT=%ROOT%\resources\bin"
set "OBJ=%ROOT%\native\capture\obj"

for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS=%%i"
if not defined VS (
  echo MSVC build tools not found. Install "Desktop development with C++" from Visual Studio Build Tools.
  exit /b 1
)
call "%VS%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 -no_logo || exit /b 1

if not exist "%OUT%" mkdir "%OUT%"
if not exist "%OBJ%" mkdir "%OBJ%"
cl /nologo /std:c++17 /O2 /EHsc /MT /W4 /utf-8 /DUNICODE /D_UNICODE ^
  /Fo"%OBJ%\\" "%~dp0syncwave-capture.cpp" ^
  /Fe"%OUT%\syncwave-capture.exe" ^
  /link /SUBSYSTEM:CONSOLE ole32.lib mmdevapi.lib avrt.lib version.lib user32.lib || exit /b 1
echo Built %OUT%\syncwave-capture.exe
