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

    // Ensure protocol
    if (!url.match(/^https?:\/\//)) {
        url = 'http://' + url;
    }

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

/**
 * Parse a forward URL into its components
 * @param {string} url - The URL to parse
 * @returns {object|null} - Object with hostname, port, path, protocol or null if invalid
 */
function parseForwardUrl(url) {
    if (!url) return null;

    // Ensure protocol
    if (!url.match(/^https?:\/\//)) {
        url = 'http://' + url;
    }

    try {
        const urlObj = new URL(url);
        return {
            hostname: urlObj.hostname,
            port: parseInt(urlObj.port, 10) || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname || '/webhook/modelriver',
            protocol: urlObj.protocol.replace(':', '')
        };
    } catch (error) {
        return null;
    }
}

const LOCAL_API_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is this API host one that may be reached over plain http?
 * @param {string} hostname - URL hostname (IPv6 may be bracketed)
 * @returns {boolean}
 */
function isLocalApiHost(hostname) {
    return LOCAL_API_HOSTS.has(String(hostname || '').toLowerCase());
}

/**
 * Check an API base URL. It must be https, except for localhost,
 * 127.0.0.1 and ::1, which may use http.
 * @param {string} apiUrl
 * @returns {string} the URL without a trailing slash
 * @throws {Error} when the URL is invalid or uses http for another host
 */
function checkApiUrl(apiUrl) {
    let url;
    try {
        url = new URL(apiUrl);
    } catch (error) {
        throw new Error(`Invalid API URL "${apiUrl}"`);
    }

    if (url.protocol === 'https:') {
        return apiUrl.replace(/\/$/, '');
    }
    if (url.protocol === 'http:' && isLocalApiHost(url.hostname)) {
        return apiUrl.replace(/\/$/, '');
    }
    if (url.protocol === 'http:') {
        throw new Error(`API URL must use https (only localhost, 127.0.0.1 and ::1 may use http): ${url.origin}`);
    }
    throw new Error(`API URL must use https: ${url.origin}`);
}

module.exports = {
    normalizeWebhookUrl,
    checkApiUrl,
    isLocalApiHost,
    extractPort,
    isValidApiKeyFormat,
    parseForwardUrl
};
