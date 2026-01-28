/**
 * Language Exam Practice App - Main Entry Point
 * Uses Vite for bundling and proper Privy SDK integration
 */

import Privy, { LocalStorage } from '@privy-io/js-sdk-core';

// Make Privy available globally for the app
window.PrivySDK = { Privy, LocalStorage };

// Import the main app (will be loaded after Privy is available)
import './app.js';
