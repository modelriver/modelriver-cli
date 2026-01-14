/**
 * URL helper utilities for ModelRiver CLI
 */

/**
 * Normalize a webhook URL to ensure it ends with /webhook/modelriver
 * @param {string} url - The input URL
 * @returns {string} - Normalized URL with /webhook/modelriver path
 */
function normalizeWebhookUrl(url) {
    if (!url) return url;

    try {
        const urlObj = new URL(url);
        let pathname = urlObj.pathname;

        // Remove trailing slash
        pathname = pathname.replace(/\/$/, '');

        // Normalize the path to end with /webhook/modelriver
        if (!pathname || pathname === '') {
            pathname = '/webhook/modelriver';
        } else if (pathname === '/webhook' || pathname === '/webhook/') {
            pathname = '/webhook/modelriver';
        } else if (!pathname.endsWith('/webhook/modelriver')) {
            // If path doesn't already end with /webhook/modelriver
            if (pathname.endsWith('/modelriver')) {
                // Already has /modelriver, check if it has /webhook before it
                if (!pathname.includes('/webhook/modelriver')) {
                    pathname = '/webhook/modelriver';
                }
            } else if (!pathname.includes('/webhook')) {
                // No /webhook in path at all, append /webhook/modelriver
                pathname = pathname + '/webhook/modelriver';
            } else {
                // Has /webhook but not /modelriver, append /modelriver
                if (pathname.endsWith('/webhook')) {
                    pathname = pathname + '/modelriver';
                }
            }
        }

        urlObj.pathname = pathname;
        return urlObj.toString().replace(/\/$/, '');
    } catch (error) {
        // If URL parsing fails, try simple string manipulation
        let result = url.replace(/\/$/, '');
        if (!result.includes('/webhook/modelriver')) {
            if (result.endsWith('/webhook')) {
                result += '/modelriver';
            } else {
                result += '/webhook/modelriver';
            }
        }
        return result;
    }
}

/**
 * Extract port from a URL
 * @param {string} url - The URL to extract port from
 * @returns {number|null} - Port number or null if not found
 */
function extractPort(url) {
    try {
        const urlObj = new URL(url);
        if (urlObj.port) {
            return parseInt(urlObj.port, 10);
        }
        // Return default port based on protocol
        if (urlObj.protocol === 'https:') return 443;
        if (urlObj.protocol === 'http:') return 80;
        return null;
    } catch (error) {
        // Try regex for URLs without protocol
        const match = url.match(/:(\d+)/);
        if (match) {
            return parseInt(match[1], 10);
        }
        return null;
    }
}

/**
 * Validate API key format
 * @param {string} apiKey - The API key to validate
 * @returns {boolean} - True if valid format
 */
function isValidApiKeyFormat(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') return false;
    return apiKey.startsWith('mr_live_') || apiKey.startsWith('mr_test_');
}

module.exports = {
    normalizeWebhookUrl,
    extractPort,
    isValidApiKeyFormat
};
