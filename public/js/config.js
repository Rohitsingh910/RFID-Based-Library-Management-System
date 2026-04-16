// Configuration for the Library Kiosk Interface
const CONFIG = {
    // Operation mode: 'demo', 'koha', or 'backend'
    // 'backend' = use localhost Node.js server (recommended, solves CORS)
    mode: 'backend',

    // Koha API Configuration (for 'koha' mode)
    koha: {
        baseUrl: 'http://164.52.208.94:82/api/v1',
        auth: {
            type: 'basic', // 'basic' or 'oauth2'
            username: 'jivesna',
            password: 'library@koha123',
            // For OAuth2:
            clientId: '',
            clientSecret: ''
        },
        branchCode: 'CPL' // Your library branch code (Centerville)
    },

    // OPAC URL for catalog search
    opacUrl: 'http://164.52.208.94:800',

    // UI Configuration
    ui: {
        theme: 'dark', // 'light' or 'dark'
        language: 'en', // 'en', 'es', 'fr'
        enableAnimations: true,
        autoLogoutSeconds: 120
    },

    // RFID Configuration
    rfid: {
        pollIntervalMs: 500,
        debounceMs: 3000,
        autoSubmit: true,
        checkinRetryAttempts: 2,
        checkinRetryDelayMs: 1200
    },


    // Backend Server Configuration (for 'backend' mode)
    // This mode uses the Node.js server to avoid CORS and enable SIP2
    backend: {
        baseUrl: '/api'
    },

    // Demo Mode Configuration
    demo: {
        // Sample data for testing
        enabled: true,
        simulateNetworkDelay: true,
        delayMs: 500
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
}
