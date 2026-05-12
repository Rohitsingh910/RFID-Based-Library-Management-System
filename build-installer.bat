@echo off
setlocal

rem Punjabi University Library Kiosk - Complete Build Script
rem This script compiles the RFID bridge and then builds the Electron installer.

echo ======================================================
echo   Punjabi University Library Kiosk Build System
echo ======================================================
echo.

rem 0. Check for node_modules
if not exist "node_modules\" (
    echo [0/2] Installing dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo.
        echo Error: npm install failed.
        pause
        exit /b %ERRORLEVEL%
    )
)

rem 1. Build the RFID Bridge
echo [1/2] Compiling RFID Bridge...
if not exist "rfid-integration\build.bat" (
    echo Error: rfid-integration\build.bat not found.
    pause
    exit /b 1
)
call rfid-integration\build.bat
if %ERRORLEVEL% neq 0 (
    echo.
    echo Error: RFID Bridge compilation failed.
    echo Please ensure MSVC is installed and in your PATH.
    pause
    exit /b %ERRORLEVEL%
)
echo.

rem 2. Build the Electron Installer
echo [2/2] Packaging Electron Application...
echo This may take a few minutes...
call npm run build:installer
if %ERRORLEVEL% neq 0 (
    echo.
    echo Error: Electron build failed.
    echo Please ensure npm is installed and dependencies are up to date.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ======================================================
echo   Build Successful! 
echo   Installer location: dist\Punjabi University Library Kiosk Setup 1.0.0.exe
echo ======================================================
echo.
pause
exit /b 0
