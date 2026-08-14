/**
 * Latency Logging Middleware for Express
 * Tracks request/response latency and logs with structured output
 */

function latencyLogger(options = {}) {
  const {
    logSlowThreshold = 1000, // Log warning for requests slower than 1s
    includeHeaders = false,
    includeBody = false,
    sampleRate = 1.0 // Log 100% by default
  } = options;

  return async function (req, res, next) {
    // Sampling
    if (Math.random() > sampleRate) {
      return next();
    }

    const startTime = process.hrtime.bigint();
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    
    // Attach request ID to request for downstream use
    req.requestId = requestId;
    req.latencyStart = startTime;

    // Capture original end function
    const originalEnd = res.end;
    
    res.end = function (chunk, encoding) {
      const endTime = process.hrtime.bigint();
      const latencyMs = Number(endTime - startTime) / 1_000_000;
      
      // Restore original end
      res.end = originalEnd;
      
      // Call original end
      const result = originalEnd.call(this, chunk, encoding);
      
      // Log latency
      const logData = {
        timestamp: new Date().toISOString(),
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        latencyMs: latencyMs.toFixed(2),
        userAgent: req.get('user-agent') || 'unknown',
        ip: req.ip || req.socket?.remoteAddress || 'unknown'
      };

      if (includeHeaders) {
        logData.requestHeaders = req.headers;
        logData.responseHeaders = res.getHeaders();
      }

      if (includeBody && req.body) {
        logData.requestBody = req.body;
      }

      // Log level based on latency
      if (latencyMs >= logSlowThreshold) {
        console.warn('[LATENCY_SLOW]', JSON.stringify(logData));
      } else {
        console.log('[LATENCY]', JSON.stringify(logData));
      }

      // Store latency for metrics endpoint
      if (!global.latencyMetrics) {
        global.latencyMetrics = {
          totalRequests: 0,
          totalLatencyMs: 0,
          slowRequests: 0,
          byEndpoint: {}
        };
      }
      
      global.latencyMetrics.totalRequests++;
      global.latencyMetrics.totalLatencyMs += latencyMs;
      if (latencyMs >= logSlowThreshold) {
        global.latencyMetrics.slowRequests++;
      }
      
      const endpointKey = `${req.method} ${req.path}`;
      if (!global.latencyMetrics.byEndpoint[endpointKey]) {
        global.latencyMetrics.byEndpoint[endpointKey] = {
          count: 0,
          totalLatencyMs: 0,
          maxLatencyMs: 0
        };
      }
      global.latencyMetrics.byEndpoint[endpointKey].count++;
      global.latencyMetrics.byEndpoint[endpointKey].totalLatencyMs += latencyMs;
      global.latencyMetrics.byEndpoint[endpointKey].maxLatencyMs = 
        Math.max(global.latencyMetrics.byEndpoint[endpointKey].maxLatencyMs, latencyMs);

      return result;
    };

    next();
  };
}

function getLatencyMetrics() {
  return global.latencyMetrics || {
    totalRequests: 0,
    totalLatencyMs: 0,
    slowRequests: 0,
    byEndpoint: {}
  };
}

function resetLatencyMetrics() {
  global.latencyMetrics = {
    totalRequests: 0,
    totalLatencyMs: 0,
    slowRequests: 0,
    byEndpoint: {}
  };
}

module.exports = {
  latencyLogger,
  getLatencyMetrics,
  resetLatencyMetrics
};