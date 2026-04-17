# RFID Block Dump

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scan-tag-blocks.ps1
```

What it does:

- Connects to the FEIG MR101 reader over `feusb.dll`
- Waits for a single ISO15693 tag
- Dumps each readable block as normalized hex
- Shows printable ASCII for each block
- Shows one barcode guess from Libsys-style packed data if found

Notes:

- Leave only one tag on the reader while dumping
- Remove the tag and place it again to trigger a fresh dump
