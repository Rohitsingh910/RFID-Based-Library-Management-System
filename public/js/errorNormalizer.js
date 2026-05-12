/**
 * ErrorNormalizer
 * Shared utility to normalize backend/technical errors into user-friendly messages.
 */

const ErrorNormalizer = {
    /**
     * Accepts any thrown error / API error response (string/object/JSON).
     * Extracts the best raw message and matches it against a mapping table.
     * 
     * @param {any} error - The raw error to normalize
     * @returns {Object} { userMessage, rawMessage, code }
     */
    normalize(error) {
        let rawMessage = '';
        let errorCode = 'GENERIC_ERROR';

        // 1. Extract raw message and code if possible
        if (typeof error === 'string') {
            rawMessage = error;
            // Try to parse if it's a JSON string
            if (error.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(error);
                    rawMessage = parsed.message || parsed.error || rawMessage;
                    errorCode = parsed.code || parsed.errorCode || errorCode;
                } catch (e) {
                    // Not valid JSON, keep as string
                }
            }
        } else if (error && typeof error === 'object') {
            rawMessage = error.message || error.error || error.statusText || JSON.stringify(error);
            errorCode = error.code || error.errorCode || errorCode;
        } else {
            rawMessage = String(error || 'Unknown error');
        }

        // 4. Perform mapping
        // Strip common technical prefixes
        const cleanedRaw = rawMessage.replace(/^(Backend Error:|Koha API Error:|Koha Check-in Error:|RFID Security Error:)\s*/i, '');

        // 2. Default fallback behavior:
        // Use the cleaned message if it doesn't look technical.
        // Otherwise, use a safe generic fallback unless a specific mapping matches.
        // We test against cleanedRaw to avoid prefix-induced technical flags.
        const looksTechnical = /error|failed|exception|timeout|http|koha|sip2|{/i.test(cleanedRaw);
        let userMessage = looksTechnical 
            ? "Unable to process this request. Please try again or contact staff."
            : cleanedRaw;

        // 3. Mapping Table (Regex / Contains)
        const mappings = [
            {
                pattern: /invalid item|item not found|no item found|barcode not found/i,
                message: "Invalid item",
                code: "ITEM_NOT_FOUND"
            },
            {
                pattern: /patron not found|no patron found|card not recognized/i,
                message: "Card not recognized. Please try again or contact staff.",
                code: "PATRON_NOT_FOUND"
            },
            {
                pattern: /already issued|already checked out this book/i,
                message: "This item is already issued on your account.",
                code: "ALREADY_ISSUED"
            },
            {
                pattern: /not issued|not checked out|not currently issued/i,
                message: "This item is not currently issued.",
                code: "NOT_ISSUED"
            },
            {
                pattern: /renewal not authorized|too_many|holds|restricted|limit reached/i,
                message: "This item cannot be renewed at the kiosk. Please contact staff.",
                code: "RENEWAL_DENIED"
            },
            {
                pattern: /confirmation error|staff approval required|manual confirmation/i,
                message: "Staff assistance required. Please visit the circulation desk.",
                code: "STAFF_APPROVAL_REQUIRED"
            },
            {
                pattern: /unreachable|timeout|auth failure|connection error|connect to|failed to fetch|sip2|koha api|backend error/i,
                message: "Unable to connect to the library server. Please try again.",
                code: "CONNECTION_FAILURE"
            },
            {
                pattern: /check-in failed|checkin failed|checkout failed|check-out failed/i,
                message: "Transaction failed. Please try again or contact staff.",
                code: "TRANSACTION_FAILED"
            },
            {
                pattern: /rfid|reader|serial|hardware|afi|tag/i,
                message: "Hardware error. Please ensure items are placed correctly or contact staff.",
                code: "HARDWARE_ERROR"
            }
        ];
        
        for (const mapping of mappings) {
            if (mapping.pattern.test(cleanedRaw)) {
                userMessage = mapping.message;
                errorCode = mapping.code;
                break;
            }
        }

        // 5. Console logging (Safe for debugging, but not shown to user)
        console.groupCollapsed(`[ErrorNormalizer] ${errorCode}`);
        console.error("Raw Error:", error);
        console.log("Cleaned Message:", cleanedRaw);
        console.log("Normalized Message:", userMessage);
        console.groupEnd();

        return {
            userMessage,
            rawMessage: cleanedRaw,
            code: errorCode
        };
    }
};

// Export for non-browser environments if needed (though primarily for browser)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ErrorNormalizer;
}
