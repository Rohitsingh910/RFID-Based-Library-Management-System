#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <iostream>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "httplib.h"

using namespace std;

typedef int(__stdcall* PFN_FEUSB_ClearScanList)();
typedef int(__stdcall* PFN_FEUSB_Scan)(int scanOpt, void* searchOpt);
typedef int(__stdcall* PFN_FEUSB_GetScanListSize)();
typedef int(__stdcall* PFN_FEUSB_GetScanListPara)(int index, const char* paraId, char* value);
typedef int(__stdcall* PFN_FEUSB_OpenDevice)(long long deviceId);
typedef int(__stdcall* PFN_FEUSB_CloseDevice)(int deviceHandle);
typedef int(__stdcall* PFN_FEUSB_Transceive)(int deviceHandle, const char* iface, int direction, const unsigned char* sendData, int sendLen, unsigned char* recvData, int recvLen);
typedef int(__stdcall* PFN_FEUSB_GetErrorText)(int error, char* text);

PFN_FEUSB_ClearScanList FEUSB_ClearScanList = nullptr;
PFN_FEUSB_Scan FEUSB_Scan = nullptr;
PFN_FEUSB_GetScanListSize FEUSB_GetScanListSize = nullptr;
PFN_FEUSB_GetScanListPara FEUSB_GetScanListPara = nullptr;
PFN_FEUSB_OpenDevice FEUSB_OpenDevice = nullptr;
PFN_FEUSB_CloseDevice FEUSB_CloseDevice = nullptr;
PFN_FEUSB_Transceive FEUSB_Transceive = nullptr;
PFN_FEUSB_GetErrorText FEUSB_GetErrorText = nullptr;

const int FEUSB_SCAN_ALL = 0x0000000F;
const char* FEUSB_INTERFACE = "OBID-RCI2";
const int FEUSB_DIR_BOTH = 0x00000003;

const unsigned char BUS_ADDRESS = 0xFF;
const unsigned char CMD_RF_RESET = 0x69;
const unsigned char CMD_ISO_HOST = 0xB0;
const unsigned char CMD_CUSTOM_HOST = 0xB1;
const unsigned char ISO_CMD_INVENTORY = 0x01;
const unsigned char ISO_MODE_NEW = 0x00;
const unsigned char ISO_CMD_READ_MULTI = 0x23;
const unsigned char ISO_CMD_WRITE_AFI = 0x27;
const unsigned char ISO_CMD_GET_SYSINFO = 0x2B;

// NXP ICODE SLI custom commands for EAS (Electronic Article Surveillance)
const unsigned char NXP_MANUFACTURER_CODE = 0x04;
const unsigned char NXP_CMD_SET_EAS = 0xA2;
const unsigned char NXP_CMD_RESET_EAS = 0xA3;

const int STATUS_OK = 0x00;
const int STATUS_NO_TAG = 0x01;
const int STATUS_RF_WARNING = 0x84;

const long long APPEARANCE_GAP_MS = 500;
const long long TAG_LIVE_WINDOW_MS = 1500;
const long long TAG_RETENTION_MS = 3000;
const long long AFI_WRITE_RETRY_MS = 500;
const int AFI_WRITE_MAX_ATTEMPTS_PER_APPEARANCE = 4;
const int AFI_VERIFY_READ_RETRIES = 8;
const int AFI_VERIFY_RETRY_DELAY_MS = 50;
const int MAX_STALE_RESPONSE_RETRIES = 3;
const int STALE_RESPONSE_DELAY_MS = 20;
const int RF_RESET_DELAY_MS = 50;

struct TagInfo {
    string uid;
    string type;
    long long lastSeen = 0;
    long long lastFullRead = 0;
    long long appearanceId = 0;
    int successfulBlocksRead = 0;
    vector<unsigned char> dataBytes;
    int blockSize = 4;
    string barcode;
    string afiHex = "--";
    string afiWriteResult;
    bool afiWriteAttempted = false;
    long long lastAfiWriteAttemptMs = 0;
    int afiWriteAttempts = 0;
    string afiWriteTargetHex;
};

struct ReaderResponse {
    int status = -1;
    vector<unsigned char> payload;
    vector<unsigned char> raw;
};

map<string, TagInfo> tagDatabase;
mutex dbMutex;
mutex readerLock;

atomic<bool> serverRunning(true);
atomic<bool> isReading(true);
atomic<long long> appearanceSequence(1);
atomic<int> armedAfi(-1);
atomic<bool> readerConnected(false);

string lastReaderError;
int g_deviceHandle = 0;

static long long nowMs() {
    return chrono::duration_cast<chrono::milliseconds>(
        chrono::system_clock::now().time_since_epoch()).count();
}

static string escapeJson(const string& value) {
    string out;
    for (char c : value) {
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c > 31) out += c;
    }
    return out;
}

static string toHexString(const unsigned char* data, int len) {
    char buf[8];
    string out;
    for (int index = 0; index < len; index++) {
        snprintf(buf, sizeof(buf), "%02X", data[index]);
        out += buf;
    }
    return out;
}

static string formatAfiHex(int afiValue) {
    char buf[4];
    snprintf(buf, sizeof(buf), "%02X", afiValue & 0xFF);
    return string(buf);
}

static string getFeUsbErrorText(int code) {
    if (!FEUSB_GetErrorText) return "FEUSB error " + to_string(code);
    char buffer[512] = { 0 };
    if (FEUSB_GetErrorText(code, buffer) == 0 && buffer[0] != '\0') return string(buffer);
    return "FEUSB error " + to_string(code);
}

static unsigned short getCrc16(const vector<unsigned char>& bytes) {
    unsigned short crc = 0xFFFF;
    for (unsigned char byte : bytes) {
        crc ^= byte;
        for (int index = 0; index < 8; index++) {
            if (crc & 0x0001) crc = (crc >> 1) ^ 0x8408;
            else crc >>= 1;
        }
    }
    return crc;
}

static vector<unsigned char> buildFrame(unsigned char command, const vector<unsigned char>& payload) {
    int length = 1 + 1 + 1 + static_cast<int>(payload.size()) + 2;
    vector<unsigned char> frame(length);
    frame[0] = static_cast<unsigned char>(length);
    frame[1] = BUS_ADDRESS;
    frame[2] = command;
    for (size_t index = 0; index < payload.size(); index++) frame[3 + index] = payload[index];
    unsigned short crc = getCrc16(vector<unsigned char>(frame.begin(), frame.end() - 2));
    frame[length - 2] = static_cast<unsigned char>(crc & 0xFF);
    frame[length - 1] = static_cast<unsigned char>((crc >> 8) & 0xFF);
    return frame;
}

static bool invokeReaderCommand(unsigned char command, const vector<unsigned char>& payload, const string& step, ReaderResponse& response, string& failReason);
static bool rawRfReset(string& failReason);
static bool rawReadMultipleBlocks(const string& uidHex, int startBlock, int blockCount, vector<unsigned char>& outData, int& outBlockSize, string& failReason);
static bool rawReadNormalizedBlock(const string& uidHex, int address, vector<unsigned char>& outBlock, string& failReason);
static string rawGetSystemInfo(const string& uidHex, string* outFailReason = nullptr);
static bool verifyAfiValue(const string& uidHex, const string& desiredAfiHex, string& failReason);
static bool rawWriteAfi(const string& uidHex, int afiValue, string& failReason);
static bool rawSetEas(const string& uidHex, string& failReason);
static bool rawResetEas(const string& uidHex, string& failReason);
static string decodeBarcode(const vector<unsigned char>& data);
static void refreshTagData(const string& uidHex, TagInfo& info, long long now_ms);
static void serveStatus(const httplib::Request&, httplib::Response& res);
static void serveTags(const httplib::Request&, httplib::Response& res);
static void serveArm(const httplib::Request& req, httplib::Response& res);
static void serveDisarm(const httplib::Request&, httplib::Response& res);
static void serveWriteAfi(const httplib::Request& req, httplib::Response& res);
static void runReaderLoop();

static bool invokeReaderCommand(unsigned char command, const vector<unsigned char>& payload, const string& step, ReaderResponse& response, string& failReason) {
    if (g_deviceHandle <= 0) {
        failReason = "Reader not connected";
        return false;
    }

    vector<unsigned char> frame = buildFrame(command, payload);

    for (int attempt = 0; attempt <= MAX_STALE_RESPONSE_RETRIES; attempt++) {
        unsigned char responseBuffer[4096] = { 0 };
        int responseLength = FEUSB_Transceive(
            g_deviceHandle,
            FEUSB_INTERFACE,
            FEUSB_DIR_BOTH,
            frame.data(),
            static_cast<int>(frame.size()),
            responseBuffer,
            sizeof(responseBuffer)
        );

        if (responseLength < 0) {
            failReason = step + " failed: " + getFeUsbErrorText(responseLength);
            return false;
        }

        if (responseLength < 6) {
            if (attempt < MAX_STALE_RESPONSE_RETRIES) {
                this_thread::sleep_for(chrono::milliseconds(STALE_RESPONSE_DELAY_MS));
                continue;
            }
            failReason = step + " returned incomplete FEIG response";
            return false;
        }

        vector<unsigned char> raw(responseBuffer, responseBuffer + responseLength);
        int reportedLength = raw[0] & 0xFF;
        if (reportedLength != responseLength) {
            if (attempt < MAX_STALE_RESPONSE_RETRIES) {
                this_thread::sleep_for(chrono::milliseconds(STALE_RESPONSE_DELAY_MS));
                continue;
            }
            failReason = step + " returned malformed frame length";
            return false;
        }

        unsigned short receivedCrc = static_cast<unsigned short>(raw[responseLength - 2] | (raw[responseLength - 1] << 8));
        unsigned short expectedCrc = getCrc16(vector<unsigned char>(raw.begin(), raw.end() - 2));
        if (receivedCrc != expectedCrc) {
            if (attempt < MAX_STALE_RESPONSE_RETRIES) {
                this_thread::sleep_for(chrono::milliseconds(STALE_RESPONSE_DELAY_MS));
                continue;
            }
            failReason = step + " returned invalid CRC";
            return false;
        }

        if (raw[2] != command) {
            if (attempt < MAX_STALE_RESPONSE_RETRIES) {
                this_thread::sleep_for(chrono::milliseconds(STALE_RESPONSE_DELAY_MS));
                continue;
            }
            failReason = step + " returned unexpected FEIG command byte";
            return false;
        }

        response.status = raw[3] & 0xFF;
        response.raw = raw;
        if (responseLength > 6) response.payload.assign(raw.begin() + 4, raw.end() - 2);
        else response.payload.clear();
        return true;
    }

    failReason = step + " failed after retrying stale FEIG responses";
    return false;
}

static bool rawRfReset(string& failReason) {
    ReaderResponse response;
    if (!invokeReaderCommand(CMD_RF_RESET, {}, "RF reset", response, failReason)) return false;
    if (response.status != STATUS_OK && response.status != STATUS_RF_WARNING) {
        failReason = "RF reset returned status=0x" + formatAfiHex(response.status);
        return false;
    }
    this_thread::sleep_for(chrono::milliseconds(RF_RESET_DELAY_MS));
    return true;
}

static bool isLikelyBarcodeText(const string& value) {
    if (value.length() < 4 || value.length() > 32) return false;
    bool hasDigit = false;
    for (unsigned char ch : value) {
        if (!(isalnum(ch) || ch == '-' || ch == '/')) return false;
        if (isdigit(ch)) hasDigit = true;
    }
    return hasDigit;
}

static bool decodePackedLibsysBlock(const unsigned char* block, string& barcode) {
    if (!block) return false;
    int b0 = block[0] & 0xFF;
    int b1 = block[1] & 0xFF;
    int b2 = block[2] & 0xFF;
    int b3 = block[3] & 0xFF;

    bool looksPackedLibsys =
        ((b2 >> 4) == 0x4) &&
        ((b3 >> 4) == 0x4) &&
        (b0 != 0 || b1 != 0 || b2 != 0x40 || b3 != 0x40);

    if (!looksPackedLibsys) return false;

    unsigned int hexValue =
        ((b2 & 0x0F) << 16) |
        (((b1 >> 4) & 0x0F) << 12) |
        ((b1 & 0x0F) << 8) |
        (((b0 >> 4) & 0x0F) << 4) |
        (b0 & 0x0F);

    barcode = to_string(hexValue);
    return true;
}

static string decodeBarcode(const vector<unsigned char>& data) {
    if (data.empty()) return "";

    string barcode;
    bool decoded = false;

    if (data.size() >= 4) {
        int contentType = data[0] & 0xFF;
        int barcodeLen = data[1] & 0xFF;

        if (contentType == 0x11 && barcodeLen >= 1 && barcodeLen <= 8 && (2 + barcodeLen) <= static_cast<int>(data.size())) {
            uint64_t numVal = 0;
            for (int i = 0; i < barcodeLen; i++) numVal = (numVal << 8) | (data[2 + i] & 0xFF);
            barcode = to_string(numVal);
            decoded = true;
        } else if (contentType == 0x41 && barcodeLen >= 1 && barcodeLen <= 12 && (2 + barcodeLen) <= static_cast<int>(data.size())) {
            string sixBitBarcode;
            uint64_t bitBuffer = 0;
            int bits = 0;
            bool stop = false;

            for (int i = 0; i < barcodeLen && !stop; i++) {
                bitBuffer = (bitBuffer << 8) | (data[2 + i] & 0xFF);
                bits += 8;
                while (bits >= 6 && !stop) {
                    bits -= 6;
                    int value = static_cast<int>((bitBuffer >> bits) & 0x3F);
                    if (value == 0) stop = true;
                    else if (value < 32) sixBitBarcode += static_cast<char>(value + 64);
                    else sixBitBarcode += static_cast<char>(value);
                }
            }

            if (isLikelyBarcodeText(sixBitBarcode)) {
                barcode = sixBitBarcode;
                decoded = true;
            }
        }
    }

    if (!decoded && data.size() >= 8 && decodePackedLibsysBlock(&data[4], barcode)) decoded = true;
    if (!decoded && data.size() >= 12 && decodePackedLibsysBlock(&data[8], barcode)) decoded = true;

    if (!decoded) {
        string asciiBarcode;
        for (size_t index = 0; index < data.size() && index < 32; index++) {
            int value = data[index] & 0xFF;
            if (value >= 32 && value <= 126) asciiBarcode += static_cast<char>(value);
            else if (value == 0 && index > 0) break;
        }
        if (isLikelyBarcodeText(asciiBarcode)) barcode = asciiBarcode;
    }

    return barcode;
}

static bool rawReadMultipleBlocks(const string& uidHex, int startBlock, int blockCount, vector<unsigned char>& outData, int& outBlockSize, string& failReason) {
    if (uidHex.size() < 16) {
        failReason = "Invalid UID length";
        return false;
    }

    vector<unsigned char> payload;
    payload.push_back(ISO_CMD_READ_MULTI);
    payload.push_back(0x01);
    for (int index = 0; index < 8; index++) {
        payload.push_back(static_cast<unsigned char>(stoi(uidHex.substr(index * 2, 2), nullptr, 16)));
    }
    payload.push_back(static_cast<unsigned char>(startBlock & 0xFF));
    payload.push_back(static_cast<unsigned char>((blockCount - 1) & 0xFF));

    ReaderResponse response;
    if (!invokeReaderCommand(CMD_ISO_HOST, payload, "Read Multiple Blocks", response, failReason)) return false;
    if (response.status != STATUS_OK || response.payload.size() < 2) {
        failReason = "ReadMultiBlock failed status=0x" + formatAfiHex(response.status);
        return false;
    }

    int returnedBlockCount = response.payload[0] & 0xFF;
    int returnedBlockSize = response.payload[1] & 0xFF;
    int availableDataLen = static_cast<int>(response.payload.size()) - 2;
    if (returnedBlockCount <= 0 || returnedBlockSize <= 0 || availableDataLen <= 0) {
        failReason = "No block data returned";
        return false;
    }

    int bytesPerRecord = returnedBlockSize;
    bool blockStatusPresent = false;
    if (availableDataLen == returnedBlockCount * (returnedBlockSize + 1)) {
        bytesPerRecord = returnedBlockSize + 1;
        blockStatusPresent = true;
    } else if (availableDataLen != returnedBlockCount * returnedBlockSize) {
        failReason = "Unexpected block layout";
        return false;
    }

    outBlockSize = returnedBlockSize;
    outData.clear();
    outData.reserve(returnedBlockCount * returnedBlockSize);

    for (int blockIndex = 0; blockIndex < returnedBlockCount; blockIndex++) {
        int offset = 2 + blockIndex * bytesPerRecord + (blockStatusPresent ? 1 : 0);
        for (int byteIndex = 0; byteIndex < returnedBlockSize; byteIndex++) {
            int sourceIndex = offset + (returnedBlockSize - 1 - byteIndex);
            if (sourceIndex >= static_cast<int>(response.payload.size())) {
                failReason = "Block data truncated";
                return false;
            }
            outData.push_back(response.payload[sourceIndex]);
        }
    }

    return true;
}

static bool rawReadNormalizedBlock(const string& uidHex, int address, vector<unsigned char>& outBlock, string& failReason) {
    vector<unsigned char> data;
    int blockSize = 0;
    if (!rawReadMultipleBlocks(uidHex, address, 1, data, blockSize, failReason)) return false;
    if (blockSize <= 0 || data.size() < static_cast<size_t>(blockSize)) {
        failReason = "Unexpected single block response";
        return false;
    }
    outBlock.assign(data.begin(), data.begin() + blockSize);
    return true;
}

static bool readPackedLibsysBarcodeFromBlock(const string& uidHex, int blockAddress, string& barcode) {
    vector<unsigned char> blockData;
    string failReason;
    if (!rawReadNormalizedBlock(uidHex, blockAddress, blockData, failReason)) return false;
    if (blockData.size() < 4) return false;
    return decodePackedLibsysBlock(blockData.data(), barcode);
}

static bool uidHexToBytes(const string& uidHex, vector<unsigned char>& outUid) {
    if (uidHex.size() != 16) return false;
    outUid.clear();
    outUid.reserve(8);
    try {
        for (int i = 0; i < 8; i++) {
            outUid.push_back(static_cast<unsigned char>(stoi(uidHex.substr(i * 2, 2), nullptr, 16)));
        }
    } catch (...) {
        outUid.clear();
        return false;
    }
    return true;
}

static int findUidOffset(const vector<unsigned char>& payload, const vector<unsigned char>& uidBytes) {
    if (uidBytes.size() != 8 || payload.size() < 8) return -1;
    for (size_t i = 0; (i + uidBytes.size()) <= payload.size(); i++) {
        bool match = true;
        for (size_t j = 0; j < uidBytes.size(); j++) {
            if (payload[i + j] != uidBytes[j]) {
                match = false;
                break;
            }
        }
        if (match) return static_cast<int>(i);
    }
    return -1;
}

static bool extractAfiByUidSearch(const vector<unsigned char>& payload, const string& expectedUidHex, string& outAfi, string& outFailReason) {
    vector<unsigned char> uidBytes;
    if (!uidHexToBytes(expectedUidHex, uidBytes)) {
        outFailReason = "Invalid UID";
        return false;
    }

    int uidOffset = findUidOffset(payload, uidBytes);
    if (uidOffset < 0) {
        outFailReason = "UID not found in SYSINFO payload";
        return false;
    }

    size_t uidPos = static_cast<size_t>(uidOffset);
    size_t afterUid = uidPos + 8;

    // Variant 1: [.. infoFlags][UID][optional DSFID][AFI]
    if (uidPos >= 1) {
        unsigned char infoFlags = payload[uidPos - 1];
        size_t afiPos = afterUid + ((infoFlags & 0x01) ? 1 : 0);
        if ((infoFlags & 0x02) && afiPos < payload.size()) {
            outAfi = formatAfiHex(payload[afiPos]);
            return true;
        }
    }

    // Variant 2 (seen with FEIG+SLIX): [responseFlags][UID][AFI]
    if (afterUid < payload.size()) {
        outAfi = formatAfiHex(payload[afterUid]);
        return true;
    }

    outFailReason = "AFI byte not available after UID";
    return false;
}

static string rawGetSystemInfo(const string& uidHex, string* outFailReason) {
    if (uidHex.size() < 16) {
        if (outFailReason) *outFailReason = "Invalid UID";
        return "--";
    }

    vector<unsigned char> payload;
    payload.push_back(ISO_CMD_GET_SYSINFO);
    payload.push_back(0x01);
    for (int index = 0; index < 8; index++) {
        payload.push_back(static_cast<unsigned char>(stoi(uidHex.substr(index * 2, 2), nullptr, 16)));
    }

    string failReason;
    ReaderResponse response;
    if (!invokeReaderCommand(CMD_ISO_HOST, payload, "Get System Information", response, failReason)) {
        if (outFailReason) *outFailReason = failReason;
        return "--";
    }
    if (response.status != STATUS_OK || response.payload.size() < 9) {
        if (outFailReason) *outFailReason = "Unexpected status/payload 0x" + formatAfiHex(response.status);
        return "--";
    }

    // Log raw payload for diagnostics
    cout << "[rfid-bridge] SYSINFO payload (" << response.payload.size() << "B):";
    for (size_t i = 0; i < response.payload.size() && i < 20; i++) {
        char hexBuf[8];
        snprintf(hexBuf, sizeof(hexBuf), " %02X", response.payload[i]);
        cout << hexBuf;
    }
    cout << endl;

    string afiVal;
    string parseFail;
    if (extractAfiByUidSearch(response.payload, uidHex, afiVal, parseFail)) {
        cout << "[rfid-bridge] SYSINFO AFI=" << afiVal << " mode=uid-search" << endl;
        return afiVal;
    }

    if (outFailReason) *outFailReason = parseFail;
    return "--";
}

static bool verifyAfiValue(const string& uidHex, const string& desiredAfiHex, string& failReason) {
    string lastFailure = "AFI verification failed";
    for (int verifyAttempt = 1; verifyAttempt <= AFI_VERIFY_READ_RETRIES; verifyAttempt++) {
        string getSysFailReason;
        string verifiedAfi = rawGetSystemInfo(uidHex, &getSysFailReason);
        if (verifiedAfi == desiredAfiHex) {
            failReason.clear();
            return true;
        }

        if (verifiedAfi == "--") {
            lastFailure = getSysFailReason.empty()
                ? "AFI verify unavailable"
                : ("AFI verify unavailable: " + getSysFailReason);
        } else {
            lastFailure = "AFI verify mismatch expected=" + desiredAfiHex + " got=" + verifiedAfi;
        }

        if (verifyAttempt < AFI_VERIFY_READ_RETRIES) {
            this_thread::sleep_for(chrono::milliseconds(AFI_VERIFY_RETRY_DELAY_MS));
        }
    }

    failReason = lastFailure;
    return false;
}

static void refreshTagData(const string& uidHex, TagInfo& info, long long now_ms) {
    vector<unsigned char> blockData;
    int blockSize = 4;
    string failReason;
    bool readOk = false;

    int tryBlocks = info.successfulBlocksRead > 0 ? info.successfulBlocksRead : 28;
    readOk = rawReadMultipleBlocks(uidHex, 0, tryBlocks, blockData, blockSize, failReason);
    if (!readOk && tryBlocks > 16) {
        readOk = rawReadMultipleBlocks(uidHex, 0, 16, blockData, blockSize, failReason);
        if (readOk) info.successfulBlocksRead = 16;
    }
    if (!readOk && tryBlocks > 8) {
        readOk = rawReadMultipleBlocks(uidHex, 0, 8, blockData, blockSize, failReason);
        if (readOk) info.successfulBlocksRead = 8;
    }

    if (readOk) {
        if (info.successfulBlocksRead == 0) info.successfulBlocksRead = tryBlocks;
        info.dataBytes = blockData;
        info.blockSize = blockSize;
        info.barcode = decodeBarcode(blockData);

        string verifiedBarcode;
        if (readPackedLibsysBarcodeFromBlock(uidHex, 2, verifiedBarcode)) info.barcode = verifiedBarcode;
        else if (info.barcode.empty() && readPackedLibsysBarcodeFromBlock(uidHex, 1, verifiedBarcode)) info.barcode = verifiedBarcode;

        info.lastFullRead = now_ms;
        lastReaderError.clear();
    } else {
        lastReaderError = failReason;
    }

    string afiResult = rawGetSystemInfo(uidHex);
    if (afiResult != "--") info.afiHex = afiResult;
}

static bool rawWriteAfi(const string& uidHex, int afiValue, string& failReason) {
    if (uidHex.size() < 16) {
        failReason = "Invalid UID";
        return false;
    }

    string desiredAfiHex = formatAfiHex(afiValue);
    string verifyFailure;
    if (verifyAfiValue(uidHex, desiredAfiHex, verifyFailure)) {
        // AFI already correct, but still ensure EAS matches
        string easFail;
        bool easOk = (afiValue == 0x00) ? rawResetEas(uidHex, easFail) : rawSetEas(uidHex, easFail);
        if (!easOk) {
            cout << "[rfid-bridge] EAS toggle warning (AFI already correct): " << easFail << endl;
        }
        failReason.clear();
        return true;
    }

    vector<unsigned char> payload;
    payload.push_back(ISO_CMD_WRITE_AFI);
    payload.push_back(0x01);
    for (int index = 0; index < 8; index++) {
        payload.push_back(static_cast<unsigned char>(stoi(uidHex.substr(index * 2, 2), nullptr, 16)));
    }
    payload.push_back(static_cast<unsigned char>(afiValue & 0xFF));

    string lastFailure = "Write Command Failed";
    for (int attempt = 1; attempt <= 3; attempt++) {
        string resetFailure;
        rawRfReset(resetFailure);

        ReaderResponse response;
        if (invokeReaderCommand(CMD_ISO_HOST, payload, "Write AFI", response, failReason) && response.status == STATUS_OK) {
            this_thread::sleep_for(chrono::milliseconds(40)); // allow EEPROM commit and stabilize tag

            if (verifyAfiValue(uidHex, desiredAfiHex, verifyFailure)) {
                // Toggle EAS alongside AFI: unsecure (0x00) = reset EAS, secure = set EAS
                string easFail;
                bool easOk = (afiValue == 0x00) ? rawResetEas(uidHex, easFail) : rawSetEas(uidHex, easFail);
                if (!easOk) {
                    cout << "[rfid-bridge] EAS toggle warning: " << easFail << endl;
                }
                failReason.clear();
                return true;
            }
            lastFailure = verifyFailure;
        } else {
            if (!failReason.empty()) lastFailure = failReason;
        }
        this_thread::sleep_for(chrono::milliseconds(80));
    }

    failReason = lastFailure;
    return false;
}

static bool rawEasCommand(const string& uidHex, unsigned char easCmd, const string& cmdName, string& failReason) {
    if (uidHex.size() < 16) {
        failReason = "Invalid UID";
        return false;
    }

    // NXP custom command via FEIG [0xB1] custom host command
    // Payload: [NXP_CMD] [mode=0x01 addressed] [NXP_MFR_CODE] [UID 8 bytes]
    vector<unsigned char> payload;
    payload.push_back(easCmd);
    payload.push_back(0x01);  // addressed mode
    payload.push_back(NXP_MANUFACTURER_CODE);
    for (int index = 0; index < 8; index++) {
        payload.push_back(static_cast<unsigned char>(stoi(uidHex.substr(index * 2, 2), nullptr, 16)));
    }

    for (int attempt = 1; attempt <= 3; attempt++) {
        string resetFailure;
        rawRfReset(resetFailure);

        ReaderResponse response;
        if (invokeReaderCommand(CMD_CUSTOM_HOST, payload, cmdName, response, failReason)) {
            if (response.status == STATUS_OK || response.status == STATUS_RF_WARNING) {
                cout << "[rfid-bridge] " << cmdName << " success for " << uidHex << endl;
                failReason.clear();
                return true;
            }
            failReason = cmdName + " returned status=0x" + formatAfiHex(response.status);
        }
        this_thread::sleep_for(chrono::milliseconds(80));
    }

    cout << "[rfid-bridge] " << cmdName << " failed for " << uidHex << ": " << failReason << endl;
    return false;
}

static bool rawSetEas(const string& uidHex, string& failReason) {
    return rawEasCommand(uidHex, NXP_CMD_SET_EAS, "Set EAS", failReason);
}

static bool rawResetEas(const string& uidHex, string& failReason) {
    return rawEasCommand(uidHex, NXP_CMD_RESET_EAS, "Reset EAS", failReason);
}

static vector<string> getInventorySnapshot(string& failReason) {
    vector<string> result;
    if (!rawRfReset(failReason)) return result;

    ReaderResponse response;
    if (!invokeReaderCommand(CMD_ISO_HOST, { ISO_CMD_INVENTORY, ISO_MODE_NEW }, "ISO15693 inventory", response, failReason)) return result;

    if (response.status == STATUS_NO_TAG) {
        failReason.clear();
        return result;
    }

    if (response.status != STATUS_OK || response.payload.empty()) {
        failReason = "Inventory returned FEIG status 0x" + formatAfiHex(response.status);
        return result;
    }

    int dataSetCount = response.payload[0] & 0xFF;
    int remainingBytes = static_cast<int>(response.payload.size()) - 1;
    if (dataSetCount <= 0 || remainingBytes < dataSetCount * 8) {
        failReason.clear();
        return result;
    }

    int recordLength = remainingBytes / dataSetCount;
    int offset = 1;
    for (int index = 0; index < dataSetCount; index++) {
        if (offset + recordLength > static_cast<int>(response.payload.size())) break;
        if (recordLength >= 8) {
            string uid = toHexString(&response.payload[offset + recordLength - 8], 8);
            if (!uid.empty() && find(result.begin(), result.end(), uid) == result.end()) result.push_back(uid);
        }
        offset += recordLength;
    }

    failReason.clear();
    return result;
}

static void serveStatus(const httplib::Request&, httplib::Response& res) {
    int arm = armedAfi.load();
    char buf[4];
    snprintf(buf, sizeof(buf), "%02X", arm & 0xFF);

    string json = "{"
        "\"status\":\"" + string(readerConnected.load() ? "CONNECTED" : "DISCONNECTED") + "\","
        "\"reading\":" + string(isReading.load() ? "true" : "false") + ","
        "\"tagCount\":" + to_string(tagDatabase.size()) + ","
        "\"armed\":" + string(arm >= 0 ? "true" : "false") + ","
        "\"armedAfi\":\"" + string(arm >= 0 ? buf : "") + "\","
        "\"lastError\":\"" + escapeJson(lastReaderError) + "\""
        "}";
    res.set_content(json, "application/json");
}

static void serveTags(const httplib::Request&, httplib::Response& res) {
    long long now_ms = nowMs();
    string json = "[";
    int count = 0;

    lock_guard<mutex> lock(dbMutex);
    for (auto const& [uid, tag] : tagDatabase) {
        if (count++ > 0) json += ",";
        json += "{";
        json += "\"uid\":\"" + escapeJson(tag.uid) + "\",";
        json += "\"type\":\"" + escapeJson(tag.type) + "\",";
        json += "\"barcode\":\"" + escapeJson(tag.barcode) + "\",";
        json += "\"afi\":\"" + escapeJson(tag.afiHex) + "\",";
        json += "\"appearanceId\":" + to_string(tag.appearanceId) + ",";
        json += "\"lastSeen\":" + to_string(tag.lastSeen) + ",";
        json += "\"live\":" + string((now_ms - tag.lastSeen) <= TAG_LIVE_WINDOW_MS ? "true" : "false") + ",";
        json += "\"afiWriteResult\":\"" + escapeJson(tag.afiWriteResult) + "\",";
        json += "\"afiWriteAttempted\":" + string(tag.afiWriteAttempted ? "true" : "false");
        json += "}";
    }
    json += "]";
    res.set_content(json, "application/json");
}

static void serveArm(const httplib::Request& req, httplib::Response& res) {
    if (!req.has_param("afi")) {
        res.status = 400;
        res.set_content("{\"armed\":false}", "application/json");
        return;
    }

    string n = req.get_param_value("afi");
    if (n.rfind("0x", 0) == 0 || n.rfind("0X", 0) == 0) n = n.substr(2);
    int afi = -1;
    try { afi = stoi(n, nullptr, 16) & 0xFF; } catch (...) {}
    if (afi < 0) {
        res.status = 400;
        res.set_content("{\"armed\":false}", "application/json");
        return;
    }

    armedAfi.store(afi);
    int rearmedCount = 0;
    long long now_ms = nowMs();
    {
        lock_guard<mutex> lock(dbMutex);
        for (auto& [uid, tag] : tagDatabase) {
            if ((now_ms - tag.lastSeen) <= TAG_RETENTION_MS) {
                tag.appearanceId = appearanceSequence.fetch_add(1);
                tag.afiWriteAttempted = false;
                tag.afiWriteResult.clear();
                tag.lastAfiWriteAttemptMs = 0;
                tag.afiWriteAttempts = 0;
                tag.afiWriteTargetHex.clear();
                tag.lastSeen = now_ms;
                rearmedCount++;
            }
        }
    }

    res.set_content("{\"armed\":true,\"afi\":\"" + formatAfiHex(afi) + "\",\"liveTagsRearmed\":" + to_string(rearmedCount) + "}", "application/json");
}

static void serveDisarm(const httplib::Request&, httplib::Response& res) {
    armedAfi.store(-1);
    res.set_content("{\"armed\":false}", "application/json");
}

static void serveWriteAfi(const httplib::Request& req, httplib::Response& res) {
    string uidParam = req.has_param("uid") ? req.get_param_value("uid") : "";
    string barcodeParam = req.has_param("barcode") ? req.get_param_value("barcode") : "";
    string afiParam = req.has_param("afi") ? req.get_param_value("afi") : "";

    if (uidParam.empty() && !barcodeParam.empty()) {
        lock_guard<mutex> lock(dbMutex);
        for (auto const& [uid, tag] : tagDatabase) {
            if (tag.barcode == barcodeParam) {
                uidParam = uid;
                break;
            }
        }
    }

    if (uidParam.empty()) {
        res.status = 400;
        res.set_content("{\"success\":false,\"message\":\"uid or barcode required\"}", "application/json");
        return;
    }

    if (afiParam.rfind("0x", 0) == 0 || afiParam.rfind("0X", 0) == 0) afiParam = afiParam.substr(2);
    int afiValue = -1;
    try { afiValue = stoi(afiParam, nullptr, 16) & 0xFF; } catch (...) {}
    if (afiValue < 0) {
        res.status = 400;
        res.set_content("{\"success\":false,\"message\":\"Valid AFI hex required\"}", "application/json");
        return;
    }

    string desiredAfiHex = formatAfiHex(afiValue);

    // Fast path: if the background loop already wrote this exact AFI successfully 
    // for this tag appearance, we can return success immediately even if the tag 
    // was just removed from the reader during the SIP2 transaction.
    {
        lock_guard<mutex> lock(dbMutex);
        auto it = tagDatabase.find(uidParam);
        if (it != tagDatabase.end()) {
            if (it->second.afiHex == desiredAfiHex && 
                it->second.afiWriteAttempted && 
                it->second.afiWriteResult == "success") {
                
                res.set_content("{\"success\":true,\"message\":\"AFI already updated (cached)\",\"uid\":\"" + escapeJson(uidParam) + "\",\"afi\":\"" + desiredAfiHex + "\"}", "application/json");
                return;
            }
        }
    }

    string failReason;
    bool ok = false;
    {
        lock_guard<mutex> lock(readerLock);
        ok = rawWriteAfi(uidParam, afiValue, failReason);
    }

    if (ok) {
        res.set_content("{\"success\":true,\"message\":\"AFI updated\",\"uid\":\"" + escapeJson(uidParam) + "\",\"afi\":\"" + formatAfiHex(afiValue) + "\"}", "application/json");
    } else {
        res.status = 500;
        res.set_content("{\"success\":false,\"message\":\"" + escapeJson(failReason) + "\"}", "application/json");
    }
}

static void runReaderLoop() {
    char exePath[MAX_PATH];
    GetModuleFileNameA(nullptr, exePath, MAX_PATH);
    string exeDir = exePath;
    size_t lastSlash = exeDir.find_last_of("\\/");
    if (lastSlash != string::npos) exeDir = exeDir.substr(0, lastSlash);
    string dllPath = exeDir + "\\feusb.dll";

    HMODULE hDLL = LoadLibraryA(dllPath.c_str());
    if (!hDLL) {
        lastReaderError = "Could not load " + dllPath + " (Error: " + to_string(GetLastError()) + ")";
        cout << "[rfid-bridge] " << lastReaderError << endl;
        return;
    }

    FEUSB_ClearScanList = (PFN_FEUSB_ClearScanList)GetProcAddress(hDLL, "FEUSB_ClearScanList");
    FEUSB_Scan = (PFN_FEUSB_Scan)GetProcAddress(hDLL, "FEUSB_Scan");
    FEUSB_GetScanListSize = (PFN_FEUSB_GetScanListSize)GetProcAddress(hDLL, "FEUSB_GetScanListSize");
    FEUSB_GetScanListPara = (PFN_FEUSB_GetScanListPara)GetProcAddress(hDLL, "FEUSB_GetScanListPara");
    FEUSB_OpenDevice = (PFN_FEUSB_OpenDevice)GetProcAddress(hDLL, "FEUSB_OpenDevice");
    FEUSB_CloseDevice = (PFN_FEUSB_CloseDevice)GetProcAddress(hDLL, "FEUSB_CloseDevice");
    FEUSB_Transceive = (PFN_FEUSB_Transceive)GetProcAddress(hDLL, "FEUSB_Transceive");
    FEUSB_GetErrorText = (PFN_FEUSB_GetErrorText)GetProcAddress(hDLL, "FEUSB_GetErrorText");

    if (!FEUSB_ClearScanList || !FEUSB_Scan || !FEUSB_GetScanListSize || !FEUSB_GetScanListPara || !FEUSB_OpenDevice || !FEUSB_CloseDevice || !FEUSB_Transceive) {
        lastReaderError = "Failed to map all functions from feusb.dll.";
        cout << "[rfid-bridge] " << lastReaderError << endl;
        FreeLibrary(hDLL);
        return;
    }

    FEUSB_ClearScanList();
    FEUSB_Scan(FEUSB_SCAN_ALL, nullptr);

    int count = FEUSB_GetScanListSize();
    if (count <= 0) {
        lastReaderError = "No FEIG reader found on USB.";
        cout << "[rfid-bridge] " << lastReaderError << endl;
        FreeLibrary(hDLL);
        return;
    }

    char deviceIdStr[256] = { 0 };
    FEUSB_GetScanListPara(0, "Device-ID", deviceIdStr);
    long long deviceId = stoll(deviceIdStr, nullptr, 16);

    g_deviceHandle = FEUSB_OpenDevice(deviceId);
    if (g_deviceHandle <= 0) {
        lastReaderError = "FEUSB_OpenDevice failed!";
        cout << "[rfid-bridge] " << lastReaderError << endl;
        FreeLibrary(hDLL);
        return;
    }

    readerConnected = true;
    lastReaderError.clear();
    cout << "[rfid-bridge] MR101 Connected (Handle " << g_deviceHandle << ")" << endl;

    while (serverRunning.load()) {
        try {
            long long now_ms = nowMs();
            vector<string> discoveredUids;

            if (isReading.load()) {
                string failReason;
                {
                    lock_guard<mutex> readerReaderLock(readerLock);
                    discoveredUids = getInventorySnapshot(failReason);
                }

                if (!failReason.empty()) lastReaderError = failReason;
                else lastReaderError.clear();

                for (const string& uid : discoveredUids) {
                    {
                        lock_guard<mutex> lock(dbMutex);
                        bool isNew = (tagDatabase.find(uid) == tagDatabase.end());
                        TagInfo& info = tagDatabase[uid];
                        long long previousLastSeen = info.lastSeen;
                        info.uid = uid;
                        info.type = "ISO 15693";
                        bool isNewAppearance = isNew || previousLastSeen == 0 || ((now_ms - previousLastSeen) > APPEARANCE_GAP_MS);
                        if (isNewAppearance) {
                            info.appearanceId = appearanceSequence.fetch_add(1);
                            info.afiWriteAttempted = false;
                            info.afiWriteResult.clear();
                            info.lastAfiWriteAttemptMs = 0;
                            info.afiWriteAttempts = 0;
                            info.afiWriteTargetHex.clear();
                        }
                        info.lastSeen = now_ms;
                    }

                    bool shouldAutoWrite = false;
                    bool needsRead = false;
                    int currentArm = armedAfi.load();
                    string desiredAfiHex = currentArm >= 0 ? formatAfiHex(currentArm) : "";

                    {
                        lock_guard<mutex> lock(dbMutex);
                        TagInfo& info = tagDatabase[uid];
                        bool afiAlreadyCorrect = (!desiredAfiHex.empty() && info.afiHex == desiredAfiHex);
                        bool retryWindowOpen = (now_ms - info.lastAfiWriteAttemptMs) >= AFI_WRITE_RETRY_MS;
                        bool canRetryFailure = info.afiWriteResult.rfind("failed:", 0) == 0 &&
                            info.afiWriteAttempts < AFI_WRITE_MAX_ATTEMPTS_PER_APPEARANCE &&
                            retryWindowOpen;
                        shouldAutoWrite = currentArm >= 0 && !afiAlreadyCorrect &&
                            (!info.afiWriteAttempted || info.afiWriteTargetHex != desiredAfiHex || canRetryFailure);

                        if (currentArm >= 0 && afiAlreadyCorrect) {
                            info.afiWriteAttempted = true;
                            info.afiWriteResult = "success";
                            info.afiWriteTargetHex = desiredAfiHex;
                        }

                        needsRead = ((now_ms - info.lastFullRead) > 1500 || info.successfulBlocksRead == 0);
                    }

                    if (shouldAutoWrite) {
                        string fr;
                        bool ok = false;
                        {
                            lock_guard<mutex> lock(readerLock);
                            ok = rawWriteAfi(uid, currentArm, fr);
                        }
                        lock_guard<mutex> lock(dbMutex);
                        TagInfo& info = tagDatabase[uid];
                        info.afiWriteAttempted = true;
                        info.lastAfiWriteAttemptMs = now_ms;
                        info.afiWriteAttempts += 1;
                        info.afiWriteTargetHex = desiredAfiHex;
                        info.afiWriteResult = ok ? "success" : ("failed: " + fr);
                        if (ok) info.afiHex = desiredAfiHex;
                    }

                    if (needsRead) {
                        lock_guard<mutex> readLock(readerLock);
                        lock_guard<mutex> dbLock(dbMutex);
                        refreshTagData(uid, tagDatabase[uid], now_ms);
                    }
                }

                lock_guard<mutex> lock(dbMutex);
                for (auto it = tagDatabase.begin(); it != tagDatabase.end();) {
                    if ((now_ms - it->second.lastSeen) > TAG_RETENTION_MS) it = tagDatabase.erase(it);
                    else ++it;
                }
            }
        } catch (const exception& e) {
            cout << "[rfid-bridge] Exception in reader loop: " << e.what() << endl;
        } catch (...) {
            cout << "[rfid-bridge] Unknown exception in reader loop!" << endl;
        }

        this_thread::sleep_for(chrono::milliseconds(150));
    }

    readerConnected = false;
    FEUSB_CloseDevice(g_deviceHandle);
    g_deviceHandle = 0;
    FreeLibrary(hDLL);
    cout << "[rfid-bridge] Disconnected." << endl;
}

int main() {
    try {
        httplib::Server server;
        server.Get("/api/status", serveStatus);
        server.Get("/api/tags", serveTags);
        server.Get("/api/arm", serveArm);
        server.Get("/api/disarm", serveDisarm);
        server.Get("/api/write-afi", serveWriteAfi);

        thread readerThread(runReaderLoop);
        bool listenResult = server.listen("127.0.0.1", 3210);

        if (!listenResult) {
            cerr << "[rfid-bridge] CRITICAL ERROR: Could not listen on 127.0.0.1:3210." << endl;
            serverRunning = false;
            if (readerThread.joinable()) readerThread.join();
            return 1;
        }

        serverRunning = false;
        if (readerThread.joinable()) readerThread.join();
        return 0;
    } catch (const exception& e) {
        cerr << "[rfid-bridge] FATAL EXCEPTION in main: " << e.what() << endl;
        return 1;
    } catch (...) {
        cerr << "[rfid-bridge] FATAL UNKNOWN EXCEPTION in main!" << endl;
        return 1;
    }
}
