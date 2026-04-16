# RFID Integration Workspace

This directory contains the MR101 native C++ bridge used by `finalpUI`.

## Intent

`finalpUI/server.js` compiles and launches the native C++ bridge automatically on startup so the browser only needs the Node app.

## Main files

- `src/Mr101RfidBridge.cpp`
- `build.bat`
- `build/` generated executable and copied FEIG DLLs

## Runtime dependency roots

The bridge builds against the FEIG C++ SDK at:

`C:\Users\NIELIT\Desktop\New folder1\FEIG.ID.SDK.Gen3.Windows.Cpp-v6.11.0`
