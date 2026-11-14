const readline = require('readline');
const config = require('../lib/config');
const Logger = require('../utils/logger');
const { normalizeWebhookUrl, isValidApiKeyFormat, checkApiUrl } = require('../utils/url-helpers');

const { maskSecret } = require('../utils/secrets');

/**
 * Create a readline interface for interactive prompts
 */
function createReadlineInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

/**
 * Prompt user for input
 * @param {readline.Interface} rl - Readline interface
 * @param {string} question - Question to ask
 * @param {string} defaultValue - Default value if user presses enter
 * @param {boolean} maskDefault - Whether to mask the default value in display
 * @param {boolean} showDefault - Whether to show the default value in brackets
 * @returns {Promise<string>} - User input
 */
function prompt(rl, question, defaultValue = '', maskDefault = false, showDefault = true) {
    return new Promise((resolve) => {
        let displayDefault = defaultValue;
        if (defaultValue && maskDefault) {
            // Show masked version like "mr_live_…a1b2"
            displayDefault = maskSecret(defaultValue);
        }

        let displayQuestion = question + ': ';

        if (showDefault && defaultValue) {
            displayQuestion = `${question} (${displayDefault}): `;
        }

        // If the question already contains the default value in brackets (redundancy check), don't append it again
        // Heuristic: check if question ends with the default value inside parens, ignoring whitespace
        if (showDefault && defaultValue && question.trim().endsWith(`(${defaultValue})`)) {
            displayQuestion = `${question}: `;
        }

        rl.question(displayQuestion, (answer) => {
            resolve(answer.trim() || defaultValue);
        });
    });
}

/**
 * Interactive login command
 * Prompts for the API key and the webhook forward URL, and saves them to
 * config.json. `--api-url` (for ModelRiver's own developers, pointing the CLI
 * at a local server) is saved too, so later commands use it without the flag
 * or MODELRIVER_API_URL; nobody is asked for it.
 */
async function loginCommand(options) {
    const rl = createReadlineInterface();

    console.log('');
    Logger.section('ModelRiver CLI Login');
    console.log('Configure your ModelRiver CLI credentials.\n');

    try {
        // Get current values for defaults
        const currentApiKey = config.getApiKey();
        const currentApiUrl = config.getSavedApiUrl();
        const currentForwardUrl = config.getForwardUrl();

        // Show current config if exists
        if (currentApiKey || currentApiUrl || currentForwardUrl) {
            Logger.info('Current configuration:');
            if (currentApiKey) {
                Logger.info(`  API Key: ${maskSecret(currentApiKey)}`);
            }
            if (currentApiUrl) {
                Logger.info(`  API URL: ${currentApiUrl}`);
            }
            if (currentForwardUrl) {
                Logger.info(`  Forward URL: ${currentForwardUrl}`);
            }
            console.log('');
        }

        // Check for environment variable shadowing
        if (process.env.MODELRIVER_API_KEY) {
            Logger.warning('WARNING: MODELRIVER_API_KEY environment variable is set.');
            Logger.warning('This environment variable will override any API key you save here.');
            Logger.warning(`Current env value: ${maskSecret(process.env.MODELRIVER_API_KEY)}`);
            Logger.warning('To use the key you are about to save, you must unset this variable:');
            Logger.warning('  unset MODELRIVER_API_KEY');
            console.log('');
        }

        if (process.env.MODELRIVER_API_URL && (currentApiUrl || (options && options.apiUrl))) {
            Logger.warning(`WARNING: MODELRIVER_API_URL is set (${process.env.MODELRIVER_API_URL}).`);
            Logger.warning('It overrides the API URL you save here. To use the saved one: unset MODELRIVER_API_URL');
            console.log('');
        }

        // Prompt for API key
        let apiKey = await prompt(
            rl,
            'Enter your ModelRiver API key',
            currentApiKey || '',
            true // maskDefault
        );

        // Validate API key format
        if (!apiKey) {
            Logger.error('API key is required.');
            Logger.info('Get your API key from https://console.modelriver.com');
            rl.close();
            process.exit(1);
        }

        if (!isValidApiKeyFormat(apiKey)) {
            Logger.error('Invalid API key format.');
            Logger.warning('API key must start with "mr_live_" or "mr_test_"');
            rl.close();
            process.exit(1);
        }

        // Only saved when --api-url is given; an earlier saved one is kept.
        let apiUrl = null;
        if (options && options.apiUrl) {
            try {
                apiUrl = checkApiUrl(options.apiUrl.trim());
            } catch (error) {
                Logger.error(error.message);
                rl.close();
                process.exit(1);
            }
        }

        // Prompt for forward URL
        // Default to the CLI local receiver port (3001), not ModelRiver API (4000).
        const defaultForwardUrl = currentForwardUrl || 'http://localhost:3001/webhook/modelriver';
        let forwardUrl = await prompt(
            rl,
            'Enter your webhook forward URL (e.g. http://localhost:3001/webhook/modelriver)',
            defaultForwardUrl,
            false, // maskDefault
            false  // showDefault - Hide the (http://...) bracket as requested
        );

        // Normalize the forward URL
        forwardUrl = normalizeWebhookUrl(forwardUrl);

        rl.close();

        // Save configuration
        const spinner = Logger.spinner('Saving configuration...');
        spinner.start();

        try {
            config.saveConfig({
                api_key: apiKey,
                forward_url: forwardUrl,
                ...(apiUrl ? { api_url: apiUrl } : {})
            });

            spinner.succeed('Configuration saved!');
            console.log('');

            // Display saved configuration
            Logger.section('Saved Configuration');
            Logger.success(`API Key: ${maskSecret(apiKey)}`);
            const savedApiUrl = apiUrl || currentApiUrl;
            if (savedApiUrl) Logger.success(`API URL: ${savedApiUrl}`);
            Logger.success(`Forward URL: ${forwardUrl}`);
            Logger.info(`Config file: ${config.getHomeConfigPath()}`);

            console.log('');
            Logger.section('Quick Start');
            Logger.info('Start forwarding webhooks:');
            console.log('  modelriver forward');
            console.log('');
            Logger.info('Or use listen with print:');
            console.log('  modelriver listen --print');
            console.log('');
            Logger.info('Test hosted tools on this machine (calls go to the same path on your server):');
            console.log('  modelriver tools --forward-to http://localhost:3000');
            console.log('');
            Logger.info('Approve or decline a tool call that waits for approval:');
            console.log('  modelriver tools show <call_id>');
            console.log('  modelriver tools approve <call_id> --end-user <id>');
            console.log('');
            Logger.info('Other useful commands:');
            console.log('  modelriver trigger -w my-workflow -m "Hello"');
            console.log('  modelriver websocket -w my-workflow -m "Test"');
            console.log('');

        } catch (error) {
            spinner.fail('Failed to save configuration');
            Logger.error(error.message);
            process.exit(1);
        }

    } catch (error) {
        rl.close();
        Logger.error(`Login failed: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { loginCommand };
