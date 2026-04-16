param(
    [int]$PollDelayMs = 200,
    [int]$TagOutAfterMs = 1500,
    [int]$MaxBlocks = 128,
    [int]$StopAfterConsecutiveReadFailures = 4
)

$ErrorActionPreference = "Stop"

# FEIG USB access is most reliable here with 32-bit PowerShell + x86 FEUSB DLLs.
if ([Environment]::Is64BitOperatingSystem -and [Environment]::Is64BitProcess -and -not $env:RFID_BLOCK_DUMP_X86) {
    $x86PowerShell = Join-Path $env:WINDIR "SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
    if (Test-Path $x86PowerShell) {
        $argList = @(
            '-ExecutionPolicy', 'Bypass',
            '-File', $MyInvocation.MyCommand.Path,
            '-PollDelayMs', $PollDelayMs,
            '-TagOutAfterMs', $TagOutAfterMs,
            '-MaxBlocks', $MaxBlocks,
            '-StopAfterConsecutiveReadFailures', $StopAfterConsecutiveReadFailures
        )
        $env:RFID_BLOCK_DUMP_X86 = '1'
        & $x86PowerShell @argList
        $exitCode = $LASTEXITCODE
        Remove-Item Env:\RFID_BLOCK_DUMP_X86 -ErrorAction SilentlyContinue
        exit $exitCode
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$sdkRootCandidates = @(
    "C:\Users\NIELIT\Desktop\New folder1\FEIG.ID.SDK.Gen3.Windows.Cpp-v6.11.0"
)
$sdkBinCandidates = @()

foreach ($sdkRoot in $sdkRootCandidates) {
    $sdkBinCandidates += @(
        (Join-Path $sdkRoot "x86.vc142\bin\release"),
        (Join-Path $sdkRoot "x86.vc142\bin\debug"),
        (Join-Path $sdkRoot "x64.vc142\bin\release"),
        (Join-Path $sdkRoot "x64.vc142\bin\debug")
    )
}

$sdkBinDir = $null
$dllPath = $null
foreach ($candidate in $sdkBinCandidates) {
    $candidateDll = Join-Path $candidate "feusb.dll"
    if (Test-Path $candidateDll) {
        $sdkBinDir = $candidate
        $dllPath = $candidateDll
        break
    }
}

if (-not $dllPath) {
    throw "FEIG USB DLL not found."
}

if ($env:PATH -notlike "*$sdkBinDir*") {
    $env:PATH = "$sdkBinDir;$env:PATH"
}

$escapedDllPath = $dllPath.Replace('\', '\\')
$typeSource = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class FeUsbNative
{
    [DllImport("$escapedDllPath", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]
    public static extern int FEUSB_ClearScanList();

    [DllImport("$escapedDllPath", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]
    public static extern int FEUSB_Scan(int scanOpt, IntPtr searchOpt);

    [DllImport("$escapedDllPath", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]
    public static extern int FEUSB_GetScanListSize();

    [DllImport("$escapedDllPath", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]
    public static extern int FEUSB_GetScanListPara(int index, string paraId, StringBuilder value);

    [DllImport("$escapedDllPath", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]
    public static extern int FEUSB_OpenDevice(long deviceId);

    [DllImport("$escapedDllPath", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]
    public static extern int FEUSB_CloseDevice(int deviceHandle);

    [DllImport("$escapedDllPath", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]
    public static extern int FEUSB_Transceive(int deviceHandle, string iface, int direction, byte[] sendData, int sendLen, byte[] recvData, int recvLen);

    [DllImport("$escapedDllPath", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]
    public static extern int FEUSB_GetErrorText(int error, StringBuilder text);
}
"@

Add-Type -TypeDefinition $typeSource

$FEUSB_SCAN_ALL = 0x0000000F
$FEUSB_INTERFACE = "OBID-RCI2"
$FEUSB_DIR_BOTH = 0x00000003
$BUS_ADDRESS = 0xFF
$CMD_RF_RESET = 0x69
$CMD_ISO_HOST = 0xB0
$ISO_CMD_INVENTORY = 0x01
$ISO_MODE_NEW = 0x00
$STATUS_OK = 0x00
$STATUS_NO_TAG = 0x01
$STATUS_RF_WARNING = 0x84
$MAX_STALE_RESPONSE_RETRIES = 3
$STALE_RESPONSE_DELAY_MS = 20
$RF_RESET_DELAY_MS = 50

function Get-FeUsbErrorText {
    param([int]$Code)

    $buffer = New-Object System.Text.StringBuilder 512
    $result = [FeUsbNative]::FEUSB_GetErrorText($Code, $buffer)
    if ($result -eq 0 -and $buffer.Length -gt 0) {
        return $buffer.ToString()
    }

    return "FEUSB error $Code"
}

function Invoke-FeUsb {
    param(
        [scriptblock]$Action,
        [string]$Step
    )

    $result = & $Action
    if ($result -ne 0) {
        throw "$Step failed: $(Get-FeUsbErrorText $result)"
    }

    return $result
}

function Get-ScanValue {
    param(
        [int]$Index,
        [string]$ParaId
    )

    $buffer = New-Object System.Text.StringBuilder 512
    $result = [FeUsbNative]::FEUSB_GetScanListPara($Index, $ParaId, $buffer)
    if ($result -ne 0) {
        throw "Reading scan parameter '$ParaId' failed: $(Get-FeUsbErrorText $result)"
    }

    return $buffer.ToString()
}

function Get-Crc16 {
    param([byte[]]$Bytes)

    $crc = 0xFFFF
    foreach ($value in $Bytes) {
        $crc = $crc -bxor $value
        for ($index = 0; $index -lt 8; $index++) {
            if (($crc -band 0x0001) -ne 0) {
                $crc = (($crc -shr 1) -bxor 0x8408)
            }
            else {
                $crc = ($crc -shr 1)
            }
        }
    }

    return ($crc -band 0xFFFF)
}

function Build-StandardProtocolFrame {
    param(
        [byte]$BusAddress,
        [byte]$Command,
        [byte[]]$Payload = @()
    )

    $length = 1 + 1 + 1 + $Payload.Length + 2
    $frame = New-Object byte[] $length
    $frame[0] = [byte]$length
    $frame[1] = $BusAddress
    $frame[2] = $Command

    if ($Payload.Length -gt 0) {
        [Array]::Copy($Payload, 0, $frame, 3, $Payload.Length)
    }

    $crc = Get-Crc16 -Bytes $frame[0..($length - 3)]
    $frame[$length - 2] = [byte]($crc -band 0xFF)
    $frame[$length - 1] = [byte](($crc -shr 8) -band 0xFF)

    return $frame
}

function Convert-ToHex {
    param([byte[]]$Bytes)

    if ($null -eq $Bytes -or $Bytes.Length -eq 0) {
        return ""
    }

    return ([System.BitConverter]::ToString($Bytes)).Replace("-", "")
}

function Convert-HexStringToByteArray {
    param([string]$HexString)

    if ([string]::IsNullOrWhiteSpace($HexString)) {
        return @()
    }

    $bytes = New-Object byte[] ($HexString.Length / 2)
    for ($index = 0; $index -lt $bytes.Length; $index++) {
        $bytes[$index] = [Convert]::ToByte($HexString.Substring($index * 2, 2), 16)
    }

    return $bytes
}

function Get-LibsysBarcodeAtOffset {
    param(
        [byte[]]$Bytes,
        [int]$Offset
    )

    if ($Offset -lt 0 -or $Bytes.Length -lt ($Offset + 4)) {
        return $null
    }

    $b0 = [int]$Bytes[$Offset]
    $b1 = [int]$Bytes[$Offset + 1]
    $b2 = [int]$Bytes[$Offset + 2]
    $b3 = [int]$Bytes[$Offset + 3]

    if (((($b2 -shr 4) -band 0x0F) -ne 0x04) -or (((($b3 -shr 4) -band 0x0F) -ne 0x04))) {
        return $null
    }

    if ($b0 -eq 0x00 -and $b1 -eq 0x00 -and $b2 -eq 0x40 -and $b3 -eq 0x40) {
        return $null
    }

    $hexText = "{0:X1}{1:X1}{2:X1}{3:X1}{4:X1}" -f `
        ($b2 -band 0x0F), `
        (($b1 -shr 4) -band 0x0F), `
        ($b1 -band 0x0F), `
        (($b0 -shr 4) -band 0x0F), `
        ($b0 -band 0x0F)

    return ([Convert]::ToInt32($hexText, 16)).ToString()
}

function Find-LibsysBarcodeInBytes {
    param([byte[]]$Bytes)

    if ($null -eq $Bytes -or $Bytes.Length -lt 4) {
        return $null
    }

    for ($offset = 0; ($offset + 4) -le $Bytes.Length; $offset++) {
        $barcode = Get-LibsysBarcodeAtOffset -Bytes $Bytes -Offset $offset
        if (-not [string]::IsNullOrWhiteSpace($barcode)) {
            return $barcode
        }
    }

    return $null
}

function Get-PrintableAscii {
    param([byte[]]$Bytes)

    if ($null -eq $Bytes -or $Bytes.Length -eq 0) {
        return ""
    }

    return -join ($Bytes | ForEach-Object {
        if ($_ -ge 32 -and $_ -le 126) { [char]$_ } else { '.' }
    })
}

function Invoke-ReaderCommand {
    param(
        [int]$DeviceHandle,
        [byte]$Command,
        [byte[]]$Payload = @(),
        [string]$Step
    )

    $frame = Build-StandardProtocolFrame -BusAddress $BUS_ADDRESS -Command $Command -Payload $Payload

    for ($attempt = 0; $attempt -le $MAX_STALE_RESPONSE_RETRIES; $attempt++) {
        $responseBuffer = New-Object byte[] 4096
        $responseLength = [FeUsbNative]::FEUSB_Transceive(
            $DeviceHandle,
            $FEUSB_INTERFACE,
            $FEUSB_DIR_BOTH,
            $frame,
            $frame.Length,
            $responseBuffer,
            $responseBuffer.Length
        )

        if ($responseLength -lt 0) {
            throw "$Step failed: $(Get-FeUsbErrorText $responseLength)"
        }

        if ($responseLength -lt 6) {
            if ($attempt -lt $MAX_STALE_RESPONSE_RETRIES) {
                Start-Sleep -Milliseconds $STALE_RESPONSE_DELAY_MS
                continue
            }

            throw "$Step returned an incomplete FEIG response."
        }

        $response = New-Object byte[] $responseLength
        [Array]::Copy($responseBuffer, 0, $response, 0, $responseLength)

        $reportedLength = [int]$response[0]
        if ($reportedLength -ne $responseLength) {
            if ($attempt -lt $MAX_STALE_RESPONSE_RETRIES) {
                Start-Sleep -Milliseconds $STALE_RESPONSE_DELAY_MS
                continue
            }

            throw "$Step returned a malformed frame length ($reportedLength != $responseLength)."
        }

        $receivedCrc = [int]$response[$responseLength - 2] -bor ([int]$response[$responseLength - 1] -shl 8)
        $expectedCrc = Get-Crc16 -Bytes $response[0..($responseLength - 3)]
        if ($receivedCrc -ne $expectedCrc) {
            if ($attempt -lt $MAX_STALE_RESPONSE_RETRIES) {
                Start-Sleep -Milliseconds $STALE_RESPONSE_DELAY_MS
                continue
            }

            throw "$Step returned an invalid CRC."
        }

        $responseCommand = [int]$response[2]
        if ($responseCommand -ne $Command) {
            if ($attempt -lt $MAX_STALE_RESPONSE_RETRIES) {
                Start-Sleep -Milliseconds $STALE_RESPONSE_DELAY_MS
                continue
            }

            throw "$Step returned an unexpected FEIG command byte 0x{0:X2}." -f $responseCommand
        }

        $status = [int]$response[3]
        $payloadLength = $responseLength - 6
        $payloadBytes = New-Object byte[] $payloadLength
        if ($payloadLength -gt 0) {
            [Array]::Copy($response, 4, $payloadBytes, 0, $payloadLength)
        }

        return [pscustomobject]@{
            Status  = $status
            Payload = $payloadBytes
            Raw     = $response
        }
    }

    throw "$Step failed after retrying stale FEIG responses."
}

function Invoke-RfReset {
    param([int]$DeviceHandle)

    $response = Invoke-ReaderCommand -DeviceHandle $DeviceHandle -Command $CMD_RF_RESET -Step "RF reset"
    if ($response.Status -notin @($STATUS_OK, $STATUS_RF_WARNING)) {
        throw "RF reset returned FEIG status 0x{0:X2}." -f $response.Status
    }

    Start-Sleep -Milliseconds $RF_RESET_DELAY_MS
}

function Parse-InventoryPayload {
    param([byte[]]$Payload)

    $records = @()
    if ($Payload.Length -lt 1) {
        return $records
    }

    $dataSetCount = [int]$Payload[0]
    if ($dataSetCount -le 0) {
        return $records
    }

    $remainingBytes = $Payload.Length - 1
    if ($remainingBytes -lt ($dataSetCount * 8)) {
        return $records
    }

    $recordLength = [int]($remainingBytes / $dataSetCount)
    $offset = 1

    for ($index = 0; $index -lt $dataSetCount; $index++) {
        if (($offset + $recordLength) -gt $Payload.Length) {
            break
        }

        $recordBytes = New-Object byte[] $recordLength
        [Array]::Copy($Payload, $offset, $recordBytes, 0, $recordLength)
        $offset += $recordLength

        if ($recordLength -lt 8) {
            continue
        }

        $uidBytes = New-Object byte[] 8
        [Array]::Copy($recordBytes, $recordLength - 8, $uidBytes, 0, 8)

        $records += [pscustomobject]@{
            Uid = (Convert-ToHex -Bytes $uidBytes)
        }
    }

    return $records
}

function Get-InventorySnapshot {
    param([int]$DeviceHandle)

    Invoke-RfReset -DeviceHandle $DeviceHandle
    $response = Invoke-ReaderCommand -DeviceHandle $DeviceHandle -Command $CMD_ISO_HOST -Payload ([byte[]]($ISO_CMD_INVENTORY, $ISO_MODE_NEW)) -Step "ISO15693 inventory"

    if ($response.Status -eq $STATUS_NO_TAG) {
        return @()
    }

    if ($response.Status -ne $STATUS_OK) {
        throw "Inventory returned FEIG status 0x{0:X2}. Raw response: {1}" -f $response.Status, (Convert-ToHex -Bytes $response.Raw)
    }

    $records = @(Parse-InventoryPayload -Payload $response.Payload)
    $unique = [System.Collections.Generic.HashSet[string]]::new()
    $result = @()

    foreach ($record in $records) {
        if ([string]::IsNullOrWhiteSpace($record.Uid)) {
            continue
        }

        if ($unique.Add($record.Uid)) {
            $result += $record
        }
    }

    return $result
}

function Read-NormalizedBlock {
    param(
        [int]$DeviceHandle,
        [string]$Uid,
        [int]$Address
    )

    $uidBytes = Convert-HexStringToByteArray -HexString $Uid
    $payload = [byte[]](@(0x23, 0x01) + $uidBytes + @([byte]$Address, [byte]1))
    $frame = Build-StandardProtocolFrame -BusAddress $BUS_ADDRESS -Command $CMD_ISO_HOST -Payload $payload
    $responseBuffer = New-Object byte[] 4096
    $responseLength = [FeUsbNative]::FEUSB_Transceive(
        $DeviceHandle,
        $FEUSB_INTERFACE,
        $FEUSB_DIR_BOTH,
        $frame,
        $frame.Length,
        $responseBuffer,
        $responseBuffer.Length
    )

    if ($responseLength -lt 8 -or [int]$responseBuffer[2] -ne $CMD_ISO_HOST -or [int]$responseBuffer[3] -ne $STATUS_OK) {
        return $null
    }

    $returnedBlockCount = [int]$responseBuffer[4]
    $returnedBlockSize = [int]$responseBuffer[5]
    if ($returnedBlockCount -ne 1 -or $returnedBlockSize -le 0) {
        return $null
    }

    $availableDataLength = $responseLength - 8
    $entrySize = $returnedBlockSize
    $hasBlockStatusByte = $false
    if ($availableDataLength -eq ($returnedBlockCount * ($returnedBlockSize + 1))) {
        $entrySize = $returnedBlockSize + 1
        $hasBlockStatusByte = $true
    }
    elseif ($availableDataLength -ne ($returnedBlockCount * $returnedBlockSize)) {
        return $null
    }

    $normalized = New-Object byte[] $returnedBlockSize
    for ($index = 0; $index -lt $returnedBlockSize; $index++) {
        $sourceIndex = 6 + ($returnedBlockSize - 1 - $index)
        if ($hasBlockStatusByte) {
            $sourceIndex += 1
        }
        $normalized[$index] = [byte]$responseBuffer[$sourceIndex]
    }

    return $normalized
}

function Dump-TagBlocks {
    param(
        [int]$DeviceHandle,
        [string]$Uid
    )

    Write-Host ""
    Write-Host ("[{0}] TAG DETECTED UID {1}" -f (Get-Date -Format "HH:mm:ss"), $Uid)
    Write-Host "Reading blocks..."

    $allBytes = New-Object System.Collections.Generic.List[byte]
    $blocksRead = 0
    $consecutiveFailures = 0

    for ($block = 0; $block -lt $MaxBlocks; $block++) {
        $blockData = Read-NormalizedBlock -DeviceHandle $DeviceHandle -Uid $Uid -Address $block
        if ($null -eq $blockData) {
            if ($blocksRead -eq 0) {
                continue
            }

            $consecutiveFailures++
            if ($consecutiveFailures -ge $StopAfterConsecutiveReadFailures) {
                break
            }
            continue
        }

        $consecutiveFailures = 0
        $blocksRead++
        foreach ($value in $blockData) {
            $allBytes.Add($value)
        }

        $hex = Convert-ToHex -Bytes $blockData
        $ascii = Get-PrintableAscii -Bytes $blockData
        Write-Host ("BLOCK {0:D3}: {1}  ASCII:{2}" -f $block, $hex, $ascii)
    }

    if ($blocksRead -eq 0) {
        Write-Host "No readable blocks found."
        return
    }

    $allBytesArray = $allBytes.ToArray()
    $fullHex = Convert-ToHex -Bytes $allBytesArray
    $barcodeGuess = Find-LibsysBarcodeInBytes -Bytes $allBytesArray

    Write-Host ""
    Write-Host ("Blocks read : {0}" -f $blocksRead)
    Write-Host ("Full hex    : {0}" -f $fullHex)
    if (-not [string]::IsNullOrWhiteSpace($barcodeGuess)) {
        Write-Host ("Barcode guess: {0}" -f $barcodeGuess)
    }
    else {
        Write-Host "Barcode guess: not detected from Libsys pattern"
    }
    Write-Host ""
}

$deviceHandle = 0

try {
    Invoke-FeUsb -Step "Clearing FEIG USB scan list" -Action { [FeUsbNative]::FEUSB_ClearScanList() } | Out-Null
    Invoke-FeUsb -Step "Scanning FEIG USB devices" -Action { [FeUsbNative]::FEUSB_Scan($FEUSB_SCAN_ALL, [IntPtr]::Zero) } | Out-Null

    $deviceCount = [FeUsbNative]::FEUSB_GetScanListSize()
    if ($deviceCount -le 0) {
        throw "No FEIG USB reader found."
    }

    $deviceIdText = Get-ScanValue -Index 0 -ParaId "Device-ID"
    $deviceName = Get-ScanValue -Index 0 -ParaId "DeviceName"
    $familyName = Get-ScanValue -Index 0 -ParaId "FamilyName"
    $deviceId = [Convert]::ToInt64($deviceIdText, 16)

    Write-Host "Opening reader:"
    Write-Host "  Device-ID  : $deviceIdText"
    Write-Host "  DeviceName : $deviceName"
    Write-Host "  FamilyName : $familyName"

    $deviceHandle = [FeUsbNative]::FEUSB_OpenDevice($deviceId)
    if ($deviceHandle -le 0) {
        throw "Opening the FEIG USB reader failed: $(Get-FeUsbErrorText $deviceHandle)"
    }

    Write-Host ""
    Write-Host "Reader opened successfully."
    Write-Host "USB handle: $deviceHandle"
    Write-Host "Waiting for a single ISO15693 tag. Press Ctrl+C to stop."
    Write-Host ""

    $seenState = @{}
    $dumpedState = @{}
    $lastMultiTagVisible = $false

    while ($true) {
        $records = @(Get-InventorySnapshot -DeviceHandle $deviceHandle)
        $uidsNow = @{}
        $now = Get-Date

        if ($records.Count -gt 1) {
            if (-not $lastMultiTagVisible) {
                Write-Host ("[{0}] Multiple tags visible ({1}). Remove extras and leave one tag only." -f (Get-Date -Format "HH:mm:ss"), $records.Count)
            }
            $lastMultiTagVisible = $true
        }
        else {
            $lastMultiTagVisible = $false
        }

        foreach ($record in $records) {
            $uid = $record.Uid
            $uidsNow[$uid] = $true

            if (-not $seenState.ContainsKey($uid)) {
                $seenState[$uid] = $now
            }
            else {
                $seenState[$uid] = $now
            }

            if ($records.Count -eq 1 -and (-not $dumpedState.ContainsKey($uid))) {
                $dumpedState[$uid] = $true
                Dump-TagBlocks -DeviceHandle $deviceHandle -Uid $uid
            }
        }

        foreach ($uid in @($seenState.Keys)) {
            if ($uidsNow.ContainsKey($uid)) {
                continue
            }

            $lastSeen = [datetime]$seenState[$uid]
            if (($now - $lastSeen).TotalMilliseconds -ge $TagOutAfterMs) {
                $seenState.Remove($uid) | Out-Null
                $dumpedState.Remove($uid) | Out-Null
                Write-Host ("[{0}] TAG OUT {1}" -f (Get-Date -Format "HH:mm:ss"), $uid)
            }
        }

        Start-Sleep -Milliseconds $PollDelayMs
    }
}
finally {
    if ($deviceHandle -gt 0) {
        [void][FeUsbNative]::FEUSB_CloseDevice($deviceHandle)
        Write-Host ""
        Write-Host "USB handle closed."
    }
}
