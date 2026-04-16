@echo off
setlocal

rem Build script to compile C++ Bridge using MSVC

rem Set MSVC Environment - Try typical VS paths
set "VSCMD="

rem Common Visual Studio 2022/2019 Paths
if exist "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars32.bat" set "VSCMD=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars32.bat"
if exist "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars32.bat" set "VSCMD=C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars32.bat"
if exist "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars32.bat" set "VSCMD=C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars32.bat"
if exist "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars32.bat" set "VSCMD=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars32.bat"
if exist "C:\Program Files (x86)\Microsoft Visual Studio\2017\BuildTools\VC\Auxiliary\Build\vcvars32.bat" set "VSCMD=C:\Program Files (x86)\Microsoft Visual Studio\2017\BuildTools\VC\Auxiliary\Build\vcvars32.bat"

if "%VSCMD%"=="" (
    echo MSVC compiler not found. Please run this in the Developer Command Prompt for VS.
    exit /b 1
)

echo Initializing MSVC environment...
call "%VSCMD%" >nul 2>&1

set "SRC_DIR=%~dp0src"
set "BUILD_DIR=%~dp0build"
set "SDK_ROOT=C:\Users\NIELIT\Desktop\New folder1\FEIG.ID.SDK.Gen3.Windows.Cpp-v6.11.0\x86.vc142"

if not exist "%BUILD_DIR%" mkdir "%BUILD_DIR%"

echo Compiling Mr101RfidBridge.cpp...
cl.exe /EHsc /MD /std:c++17 /O2 ^
    /I"%SDK_ROOT%\include" ^
    /I"%SDK_ROOT%\include\fedm" ^
    /I"%~dp0vendor\include" ^
    "%SRC_DIR%\Mr101RfidBridge.cpp" ^
    /link /OUT:"%BUILD_DIR%\Mr101RfidBridge.exe" ^
    user32.lib ws2_32.lib advapi32.lib > "%BUILD_DIR%\compile.log" 2>&1

if %ERRORLEVEL% neq 0 (
    echo Compilation failed! See build/compile.log for details.
    type "%BUILD_DIR%\compile.log"
    exit /b %ERRORLEVEL%
)

echo Compilation successful.
echo Copying dependencies...
xcopy /Y "%SDK_ROOT%\bin\release\*.dll" "%BUILD_DIR%\"
exit /b 0
