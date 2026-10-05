/**
 * 9Router Provider - Supports both local and public endpoints
 * Local: http://192.168.1.183:20128 (VM) - Bearer token auth
 * Public: https://9r.dasun.app - Cloudflare Access + Bearer token auth
 */

// const { callLlmApi } = require('../utils/llm-api'); // REMOVED - using native fetch

class NineRouterProvider {
  constructor(config = {}) {
    this.localUrl = config.localUrl || process.env.NINEROUTER_LOCAL_URL || 'http://192.168.1.183:20128';
    this.publicUrl = config.publicUrl || process.env.NINEROUTER_PUBLIC_URL || 'https://9r.dasun.app';
    this.apiKey = config.apiKey || process.env.NINEROUTER_API_KEY;
    this.cfClientId = config.cfClientId || process.env.CF_ACCESS_CLIENT_ID;
    this.cfClientSecret = config.cfClientSecret || process.env.CF_ACCESS_CLIENT_SECRET;
    this.usePublic = config.usePublic || process.env.NINEROUTER_USE_PUBLIC === 'true';

    // Default to local URL
    this.baseUrl = this.usePublic ? this.publicUrl : this.localUrl;
  }

  /**
   * Get headers for the current endpoint
   */
  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // Add Cloudflare Access headers for public endpoint
    if (this.usePublic && this.cfClientId && this.cfClientSecret) {
      headers['CF-Access-Client-Id'] = this.cfClientId;
      headers['CF-Access-Client-Secret'] = this.cfClientSecret;
    }

    return headers;
  }

  /**
   * Switch endpoint (local <-> public)
   */
  setEndpoint(usePublic) {
    this.usePublic = usePublic;
    this.baseUrl = usePublic ? this.publicUrl : this.localUrl;
  }

  /**
   * Call 9Router chat completions
   */
  async callChatCompletions(params) {
    const { model, messages, maxTokens, temperature, stream, ...rest } = params;

    const payload = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature: temperature ?? 0.7,
      stream: stream ?? false,
      ...rest,
    };

    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers = this.getHeaders();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        // timeout handled by AbortController
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`9Router ${model} request failed: ${response.status} ${errorText}`);
      }

      const data = await response.json();

      // Standardize response format
      return {
        text: data.choices?.[0]?.message?.content || '',
        usage: data.usage,
        model: data.model,
        provider: '9router',
        endpoint: this.usePublic ? 'public' : 'local',
      };
    } catch (error) {
      // Add endpoint info to error for debugging
      error.endpoint = this.usePublic ? 'public' : 'local';
      error.baseUrl = this.baseUrl;
      throw error;
    }
  }

  /**
   * List available models
   */
  async listModels() {
    const url = `${this.baseUrl}/v1/models`;
    const headers = this.getHeaders();

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`9Router listModels failed: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      return data.data || data.models || [];
    } catch (error) {
      error.endpoint = this.usePublic ? 'public' : 'local';
      error.baseUrl = this.baseUrl;
      throw error;
    }
  }

  /**
   * Try local first, then fall back to public with Cloudflare
   */
  async callWithFallback(params) {
    // Try local endpoint first
    this.setEndpoint(false);
    try {
      return await this.callChatCompletions(params);
    } catch (localError) {
      console.warn('[9Router] Local endpoint failed, trying public with Cloudflare:', localError.message);

      // Try public endpoint with Cloudflare headers
      this.setEndpoint(true);
      try {
        return await this.callChatCompletions(params);
      } catch (publicError) {
        // Combine errors
        const combinedError = new Error(
          `9Router both endpoints failed. Local: ${localError.message}. Public: ${publicError.message}`
        );
        combinedError.localError = localError;
        combinedError.publicError = publicError;
        throw combinedError;
      }
    }
  }
}

module.exports = { NineRouterProvider };

// Backward compatibility function
async function callNineRouter(params) {
  const provider = new NineRouterProvider();
  return provider.callWithFallback(params);
}

module.exports.callNineRouter = callNineRouter;