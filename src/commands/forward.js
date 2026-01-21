const config = require('../lib/config');
const Logger = require('../utils/logger');
const { extractPort } = require('../utils/url-helpers');
const { listenCommand } = require('./listen');

/**
 * Forward command - simplified webhook forwarding using saved config
 * This is a user-friendly shortcut for: modelriver listen --forward --print
 */
async function forwardCommand(options) {
    const { port, verbose } = options;

    // Get saved configuration
    const apiKey = config.getApiKey();
    const forwardUrl = config.getForwardUrl();

    if (!apiKey) {
        Logger.error('No API key configured.');
        Logger.info('Run "modelriver login" first to configure your credentials.');
        process.exit(1);
    }

    if (!forwardUrl) {
        Logger.error('No forward URL configured.');
        Logger.info('Run "modelriver login" first to configure your forward URL.');
        process.exit(1);
    }

    // Check if env var is overriding the config
    if (process.env.MODELRIVER_API_KEY) {
        Logger.warning('NOTICE: Using API key from MODELRIVER_API_KEY environment variable.');
        Logger.warning('This overrides your logged-in user configuration.');
        Logger.warning('Run `unset MODELRIVER_API_KEY` to use your saved login credentials.\n');
    }

    // Extract port from forward URL or use provided port
    let targetPort = port;
    if (!targetPort) {
        targetPort = extractPort(forwardUrl);
    }
    if (!targetPort) {
        targetPort = 4000; // Default port
    }

    Logger.info(`Using saved configuration:`);
    Logger.info(`  Forward URL: ${forwardUrl}`);
    Logger.info(`  Target Port: ${targetPort}`);
    console.log('');

    // Call listen command with forward options
    await listenCommand({
        apiKey,
        apiUrl: config.getApiUrl(),
        port: targetPort,
        forwardUrl: forwardUrl,
        forward: true,
        print: true,
        verbose
    });
}

module.exports = { forwardCommand };
