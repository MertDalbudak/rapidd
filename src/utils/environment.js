/**
 * Environment utilities for checking current environment
 */

/**
 * Check if the current environment is production
 * @returns {boolean} True if environment is production
 */
function isProduction() {
    return process.env.NODE_ENV === 'production';
}

/**
 * Check if the current environment is development
 * @returns {boolean} True if environment is development
 */
function isDevelopment() {
    return process.env.NODE_ENV === 'development';
}

/**
 * Check if the current environment is test
 * @returns {boolean} True if environment is test
 */
function isTest() {
    return process.env.NODE_ENV === 'test';
}

/**
 * Get the current environment name
 * @returns {string} Current environment name (defaults to 'development')
 */
function getCurrentEnvironment() {
    return process.env.NODE_ENV || 'development';
}

module.exports = {
    isProduction,
    isDevelopment,
    isTest,
    getCurrentEnvironment
};