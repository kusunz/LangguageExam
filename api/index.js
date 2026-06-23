// force vercel rebuild
try {
    const app = require('../server/server.js');
    module.exports = app;
} catch (error) {
    console.error('Server Boot Failed:', error);
    module.exports = (req, res) => {
        res.status(500).json({
            error: 'Server Boot Failed',
            message: error.message,
            stack: error.stack
        });
    };
}
