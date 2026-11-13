const readline = require('readline');
const config = require('../lib/config');
const Logger = require('../utils/logger');
const { normalizeWebhookUrl, isValidApiKeyFormat } = require('../utils/url-helpers');
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
 * Prompts for API key and forward URL, saves to config
 */
async function loginCommand(options) {
    const rl = createReadlineInterface();

    console.log('');
    Logger.section('ModelRiver CLI Login');
    console.log('Configure your ModelRiver CLI credentials.\n');

    try {
        // Get current values for defaults
        const currentApiKey = config.getApiKey();
        const currentForwardUrl = config.getForwardUrl();

        // Show current config if exists
        if (currentApiKey || currentForwardUrl) {
            Logger.info('Current configuration:');
            if (currentApiKey) {
                Logger.info(`  API Key: ${maskSecret(currentApiKey)}`);
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
                forward_url: forwardUrl
            });

            spinner.succeed('Configuration saved!');
            console.log('');

            // Display saved configuration
            Logger.section('Saved Configuration');
            Logger.success(`API Key: ${maskSecret(apiKey)}`);
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
