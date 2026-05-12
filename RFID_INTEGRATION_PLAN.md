# RFID Integration Plan For `finalpUI`

## Goal

Make `finalpUI` support MR101 RFID-based check-in and check-out while keeping the operator workflow simple:

1. Run only `npm start`
2. Open the `finalpUI` web page
3. Seamlessly process tags for Check-In, Check-Out, and Renew
4. Handle security (AFI) status automatically

## Current State

The project now has a functional native C++ bridge (`Mr101RfidBridge.exe`) that handles low-level communication with FEIG hardware via `feusb.dll`.

### Features Implemented:
- **Native C++ Bridge**: High-performance polling and tag decoding using FEIG SDK.
- **Dynamic Loading**: Loads `feusb.dll` at runtime, making the build portable across machines without requiring global SDK installation.
- **Node.js Lifecycle Management**: `server.js` automatically compiles (if needed), starts, and monitors the RFID bridge.
- **RFID Proxy**: Node.js serves as a proxy to the bridge's local HTTP API (port 3210).
- **Security Logic**: Automatically writes AFI `0xD0` (secured) on Check-In and AFI `0x00` (unsecured) on Check-Out.

## Architecture

The system uses a layered architecture to ensure stability and performance.

### 1. Native Layer (C++)
- **File**: `rfid-integration/src/Mr101RfidBridge.cpp`
- **Responsibility**: Hardware discovery, inventory polling, block reading, barcode decoding (ISO15693).
- **API**: Serves JSON over HTTP on `localhost:3210`.

### 2. Backend Layer (Node.js)
- **File**: `server.js`
- **Responsibility**: Process supervision of the C++ bridge, SIP2 communication with Koha, and providing a unified API for the frontend.
- **Endpoints**:
  - `/api/rfid/status`: Health check of the bridge.
  - `/api/rfid/tags`: Current tags detected.
  - `/api/rfid/arm?afi=XX`: Instructs the bridge to write a specific AFI to the next tag it sees.

### 3. Frontend Layer (HTML/JS)
- **Files**: `public/js/app.js`, `public/js/rfid-service.js`
- **Responsibility**: User interaction, real-time tag display, and transaction flow management.

## Build System

The build system is designed to be portable and easy to use.

### RFID Bridge Build
- **Script**: `rfid-integration/build.bat`
- **Process**:
  1. Detects MSVC (Visual Studio) installation.
  2. Compiles the bridge using standard Windows libraries and workspace-local vendor headers.
  3. Copies necessary FEIG DLLs from `vendor/bin` to the build output.
- **No external SDK required**: All headers and binary dependencies are included in the repository.

### Full Project Build
- **Script**: `build-installer.bat` (Root)
- **Process**:
  1. Executes the RFID bridge build.
  2. Executes `npm run build` to package the Electron application.
  3. Bundles the RFID bridge and DLLs as `extraResources`.

## Transaction Flows

### Check-Out
1. Patron scans their library card.
2. App arms the RFID bridge with AFI `0x00`.
3. Patron places books on the reader.
4. Bridge detects tags, decodes barcodes, and Node.js performs SIP2 checkout.
5. Bridge automatically writes AFI `0x00` to the tag.

### Check-In
1. Patron starts check-in.
2. Bridge polls for tags.
3. For each tag, Node.js performs SIP2 check-in.
4. After successful SIP2 check-in, the bridge writes AFI `0xD0` to secure the item.

## Maintenance and Troubleshooting

### Logs
- **Node.js**: `logs/app.log`
- **RFID Bridge**: `rfid-integration/build/compile.log` (Build time) and stdout (Runtime).

### Common Issues
- **Reader not found**: Ensure the MR101 is connected via USB and the blue LED is on.
- **Compilation error**: Ensure Visual Studio "Desktop development with C++" workload is installed.

