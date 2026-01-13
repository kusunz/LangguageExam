/**
 * Vercel Serverless Function Handler
 * Wraps the Express server for Vercel's serverless environment
 */

// Load environment configuration
require('dotenv').config({ path: '../server/.env' });

// Import the Express app from server
const app = require('../server/server.js');

// Export as Vercel serverless handler
module.exports = app;
