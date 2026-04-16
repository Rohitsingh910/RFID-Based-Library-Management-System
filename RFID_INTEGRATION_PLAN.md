# RFID Integration Plan For `finalpUI`

## Goal

Make `finalpUI` support MR101 RFID-based check-in while keeping the operator workflow simple:

1. Run only `npm start`
2. Open the `finalpUI` web page
3. Press `Check-In`
4. Either type the book number manually or place the RFID-tagged book on the reader
5. The page should submit the decoded library barcode and complete SIP2 check-in

## Current State

`finalpUI` already does manual SIP2 check-in successfully.

What is missing:

- No reader bridge is running from `finalpUI`
- No `/api/tags` endpoint exists in `finalpUI`
- No RFID polling/autofill logic is wired into the current page

## What Existing Code Already Proves

### 1. Existing frontend contract is simple

The kiosk frontend already expects RFID data from a plain HTTP endpoint:

- [rfid-service.js](/C:/Users/NIELIT/Desktop/Punjabi%20University/checkin%20interface/js/rfid-service.js)
- [rfid-service.js](/C:/Users/NIELIT/Desktop/Punjabi%20University/FEIG.ID.SDK.Gen3.Windows.Cpp-v6.11.0/Final_Kiosk_Project/www/js/rfid-service.js)

The frontend only needs:

```json
[
  {
    "uid": "E004...",
    "barcode": "9084"
  }
]
```

The web UI does not need to know FEIG SDK details. It only needs decoded barcodes.

### 2. Existing reader bridge already decodes library tags

The strongest implementation reference is:

- [RfidWebServer.java](/C:/Users/NIELIT/Desktop/Punjabi%20University/MR101/FEIG.ID.SDK.Gen3.Java-v6.10.0/FEIG.ID.SDK.Gen3.Java-v6.10.0/RfidWebServer.java)

Relevant behavior:

- It exposes `/api/tags` at lines near `245`
- It discovers the MR101 via USB and connects with the FEIG Java SDK at lines near `374-414`
- It runs `reader.hm().inventory()` continuously at lines near `483-486`
- It filters to ISO15693 tags at lines near `502-505`
- It creates a tag handler and reads blocks using `readMultipleBlocks()` at lines near `524-548`
- It decodes the library barcode and stores it as `info.barcode` at lines near `548-553`

### 3. Existing C++ code documents the barcode decode logic clearly

The most readable decode reference is:

- [RFIDKiosk.cpp](/C:/Users/NIELIT/Desktop/Punjabi%20University/FEIG.ID.SDK.Gen3.Windows.Cpp-v6.11.0/Final_Kiosk_Project/src/RFIDKiosk.cpp)

Important parts:

- Continuous inventory with FEIG Host Mode: lines near `155-176`
- 3M/Bibliotheca numeric decode: lines near `190-200`
- 3M/Bibliotheca alphanumeric 6-bit decode: lines near `201-220`
- Plain ASCII fallback: lines near `223-230`
- `/api/tags` response with `barcode`: lines near `269-286`

### 4. Low-level Java tag reading is already understood

- [CheckReader.java](/C:/Users/NIELIT/Desktop/Punjabi%20University/MR101/FEIG.ID.SDK.Gen3.Java-v6.10.0/FEIG.ID.SDK.Gen3.Java-v6.10.0/CheckReader.java)

This confirms:

- `reader.hm().inventory()` is the inventory call
- `reader.hm().createTagHandler(tagItem)` or `select(tagItem)` is used to access tag memory
- ISO15693 system information can be read first
- Tag blocks can be dumped and decoded from raw bytes

### 5. FEIG SDK documentation direction

- [Readme.txt](/C:/Users/NIELIT/Desktop/Punjabi%20University/MR101/FEIG.ID.SDK.Gen3.Java-v6.10.0/FEIG.ID.SDK.Gen3.Java-v6.10.0/doc/Readme.txt)

This confirms the FEIG SDK expects developers to use:

- reader system manual first
- FEIG SDK bundled documentation
- sample projects for use cases

For our implementation, the existing local Java and C++ projects are already enough to proceed.

## Recommended Architecture

## Recommendation

Keep `finalpUI` as the main web app and add a Java RFID bridge process behind it.

### Final runtime shape

`npm start` should do all of this:

1. Start the Node server for `finalpUI`
2. Start a Java child process for MR101 RFID reading
3. Proxy or merge RFID endpoints into the same Node server
4. Serve one web page from one origin

### Why this is the right approach

- The FEIG Java SDK is already present and a working MR101 web server already exists
- Porting FEIG reader logic into pure Node is not realistic
- Porting the whole decode stack into C++ again is unnecessary for tomorrow’s goal
- One Node process can supervise the Java process and give the user a single `npm start` entrypoint

## Planned Implementation

## Phase 1: Extract the RFID bridge responsibility

Create a dedicated Java bridge inside or alongside `finalpUI` that does only this:

- discover MR101 over USB
- continuously inventory tags
- decode barcode from ISO15693 data
- expose current tags as JSON

Preferred approach:

- Reuse/adapt `RfidWebServer.java`
- Strip it down to only reader status and `/api/tags`
- Keep decode logic exactly aligned with the working C++ logic

Endpoints the bridge should expose:

- `GET /api/status`
- `GET /api/tags`
- optional `POST /api/start`
- optional `POST /api/stop`

## Phase 2: Make Node own the public HTTP server

Update `finalpUI/server.js` so it remains the only server the browser talks to.

Node responsibilities:

- serve the HTML/CSS/JS
- handle SIP2 `/api/checkin`
- start the Java RFID bridge on app startup
- poll or proxy RFID endpoints from Java

Preferred API shape in Node:

- `GET /api/rfid/status`
- `GET /api/rfid/tags`
- optionally alias `GET /api/tags` for compatibility

## Phase 3: Wire RFID into the current page

Add a minimal RFID polling client to `finalpUI/public/app.js`.

Behavior:

- Poll `/api/tags` every 300-500 ms only while on the check-in screen
- Read `tag.barcode`
- Debounce repeated reads of the same barcode for 2-3 seconds
- Autofill the existing book number input
- Auto-submit check-in

This keeps the current manual flow intact while adding RFID as a second input mode.

## Phase 4: Reader status in UI

Add a small status area on the page:

- Reader connected
- Reader not connected
- Scanning
- Last RFID barcode detected

This will make field troubleshooting much easier.

## Phase 5: Operational hardening

Add:

- child-process restart handling if Java bridge exits
- startup timeout/error message if Java or the MR101 is unavailable
- structured logs to file or console
- stale-tag expiry so removed books disappear quickly

## Barcode Decode Rules To Preserve

Based on the working C++ implementation, keep these rules unchanged:

### Numeric Bibliotheca format

- `data[0] == 0x11`
- `data[1]` = payload length
- bytes `data[2..]` are a big-endian integer
- decoded string is the decimal number

### Alphanumeric Bibliotheca format

- `data[0] == 0x41`
- `data[1]` = payload length
- bytes `data[2..]` use 6-bit packed encoding

### Fallback

- If neither format matches, attempt plain ASCII until null or non-printable termination rules

This is the core library-tag interpretation logic and should not be reinvented without a real tag sample proving a different encoding.

## Constraints And Risks

## Constraints

- FEIG SDK is Java-based here, so Java runtime will be required on the machine
- FEIG native libraries and JARs must be on the Java classpath and library path
- MR101 must be reachable by USB discovery on Windows

## Risks

- Reader can drop in and out during block reads
- Some tags do not report memory size cleanly
- Some tags may need fallback read lengths
- Browser polling can create duplicate submissions if debounce is wrong
- A stale background Java process can confuse testing if Node does not manage lifecycle cleanly

## Mitigations

- Use the already-proven fallback read lengths: 28, then 16, then 8 blocks
- Ignore non-ISO15693 tags
- Expire stale tags quickly
- Deduplicate by barcode in the frontend session
- Make Node spawn and own the Java bridge lifecycle

## Proposed File Changes Tomorrow

## In `finalpUI`

- `server.js`
  - add Java child-process startup
  - add RFID proxy endpoints
  - add shutdown cleanup

- `public/app.js`
  - add RFID polling
  - add debounce
  - auto-fill and auto-submit

- `public/index.html`
  - add RFID status area

- `public/styles.css`
  - add status styles

## New files likely needed

- `rfid/`
  - Java source copied/adapted from `RfidWebServer.java`
  - a launch script or compiled output arrangement

- `scripts/`
  - optional helper script to compile Java before Node launch if needed

- `README_RFID.md` or update existing README

## Practical Delivery Target

By the end of the next work session, the expected outcome should be:

1. User runs `npm start` in `finalpUI`
2. Node starts the web app and the Java RFID bridge
3. User opens the page
4. User presses `Check-In`
5. Placing a tagged book on MR101 auto-fills the barcode and submits check-in
6. Success card shows the title from Koha and the check-in completes through SIP2

## Tomorrow’s First Steps

1. Decide whether to embed Java source inside `finalpUI` or reference the MR101 folder directly
2. Make Node spawn the Java bridge and confirm `/api/tags` works from `finalpUI`
3. Reuse the existing RFID polling behavior from the prior kiosk UI
4. Test with one known working tag such as the item whose decoded barcode is already known in Koha

## Recommendation For Tomorrow

Do not start by rewriting FEIG logic.

Start by reusing the working Java bridge and integrating it into `finalpUI` behind one `npm start`. That is the shortest path with the least technical risk.
