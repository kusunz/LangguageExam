const fs = require('fs');
const path = require('path');

const diagnostics = {
    cwd: process.cwd(),
    files: [],
    modules: {},
    env: Object.keys(process.env)
};

try {
    diagnostics.files = fs.readdirSync(__dirname);
} catch (e) { diagnostics.files = e.message; }

const deps = ['express', 'pg', 'cors', 'dotenv', 'jose', '@deepgram/sdk', 'express-rate-limit', './db', '../server/server.js'];

deps.forEach(dep => {
    try {
        require.resolve(dep);
        diagnostics.modules[dep] = 'OK';
    } catch (e) {
        diagnostics.modules[dep] = 'MISSING: ' + e.message;
    }
});

try {
    // Attempt actual boot
    const app = require('../server/server.js');
    module.exports = app;
} catch (error) {
    console.error('Server Boot Failed:', error);
    module.exports = (req, res) => {
        res.status(500).json({
            error: 'Server Boot Failed',
            message: error.message,
            stack: error.stack,
            diagnostics: diagnostics
        });
    };
}
