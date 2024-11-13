const { getSecret } = require('../utils/secretManager');

const config = {};

async function initializeConfig() {
  try {
    console.log('Initializing configuration...');

    // Get JWT secret
    config.JWT_SECRET = await getSecret('jwt-secret');
    console.log('JWT_SECRET obtained successfully.');

    // Get WordPress credentials
    let wpApiUrl = (await getSecret('WORDPRESS_API_URL')).trim();
    wpApiUrl = wpApiUrl.replace('www.resources', 'resources');
    config.WORDPRESS_API_URL = wpApiUrl;
    
    config.WORDPRESS_USERNAME = (await getSecret('wp_username')).trim();
    config.WORDPRESS_APP_PASSWORD = (await getSecret('wp_app_password')).trim();
    console.log('WordPress credentials obtained successfully.');

    // Get SendGrid credentials
    config.SENDGRID_API_KEY = (await getSecret('SENDGRID_API_KEY')).trim();
    config.SENDGRID_EMAIL = (await getSecret('SENDGRID_EMAIL')).trim();
    config.SEND_GRID_TEMPLATE_NOTIFY_APPRAISAL_COMPLETED = (await getSecret('SEND_GRID_TEMPLATE_NOTIFY_APPRAISAL_COMPLETED')).trim();
    config.SEND_GRID_TEMPLATE_NOTIFY_APPRAISAL_UPDATE = (await getSecret('SEND_GRID_TEMPLATE_NOTIFY_APPRAISAL_UPDATE')).trim();
    console.log('SendGrid credentials obtained successfully.');

    // Get Google Sheets configuration
    config.PENDING_APPRAISALS_SPREADSHEET_ID = (await getSecret('PENDING_APPRAISALS_SPREADSHEET_ID')).trim();
    config.GOOGLE_SHEET_NAME = (await getSecret('GOOGLE_SHEET_NAME')).trim();
    console.log('Spreadsheet configuration obtained successfully.');

    // Get Google Cloud configuration
    config.GOOGLE_CLOUD_PROJECT_ID = (await getSecret('GOOGLE_CLOUD_PROJECT_ID')).trim();
    console.log('Google Cloud configuration obtained successfully.');

    // Get OpenAI configuration
    config.OPENAI_API_KEY = (await getSecret('OPENAI_API_KEY')).trim();
    console.log('OpenAI configuration obtained successfully.');

    console.log('All configurations initialized successfully.');
    return config;
  } catch (error) {
    console.error('Error initializing configuration:', error);
    throw error;
  }
}

module.exports = { config, initializeConfig };