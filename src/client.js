import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'https-proxy-agent';
const { HttpsProxyAgent } = pkg;
import { logger } from './logger.js';

export class GrassClient {
  constructor(userId, proxy = null) {
    this.userId = userId;
    this.proxy = proxy;
    this.ws = null;
    this.browserId = uuidv4();
    this.heartbeatInterval = null;
    this.healthCheckInterval = null;
    this.lastPingTime = null;
    this.lastPongTime = null;
    this.connectionAttempts = 0;
    this.pointsMultiplier = 1.0;
    this.isReconnecting = false;
    this.maxRetries = 5;
    this.retryDelay = 10000;
  }

  async start() {
    while (true) {
      try {
        if (!this.isReconnecting) {
          await this.connect();
          await this.authenticate();
          this.startHeartbeat();
          this.startHealthCheck();
          
          await new Promise((resolve) => {
            this.ws.once('close', () => {
              logger.warn(`Connection closed for proxy: ${this.proxy}`);
              resolve();
            });
          });
        }
        
        this.cleanup();
        this.isReconnecting = true;
        this.connectionAttempts++;
        
        const delay = Math.min(this.retryDelay * Math.pow(1.5, this.connectionAttempts - 1), 300000);
        logger.info(`Initiating automatic reconnection in ${Math.round(delay/1000)}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        if (this.connectionAttempts >= this.maxRetries) {
          logger.warn('Max retry attempts reached, resetting connection state...');
          this.connectionAttempts = 0;
          await new Promise(resolve => setTimeout(resolve, 60000));
        }
      } catch (error) {
        logger.error(`Connection error: ${error.message}`);
        this.cleanup();
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
      }
    }
  }

  startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      this.checkConnectionHealth();
    }, 15000);
  }

  async checkConnectionHealth() {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error('Connection lost');
      }

      const currentTime = Date.now();
      if (this.lastPingTime && currentTime - this.lastPingTime > 60000) {
        throw new Error('No ping received in 60 seconds');
      }

      if (this.pointsMultiplier < 1.0) {
        logger.warn('Points multiplier abnormal, initiating reconnection');
        this.forceReconnect();
      }

    } catch (error) {
      logger.error(`Health check failed: ${error.message}`);
      this.forceReconnect();
    }
  }

  forceReconnect() {
    if (!this.isReconnecting) {
      this.isReconnecting = true;
      this.cleanup();
      logger.info('Forcing reconnection due to health check failure');
    }
  }

  async connect() {
    const options = {
      headers: {
        'Host': 'proxy2.wynd.network:4650',
        'Connection': 'Upgrade',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        'Upgrade': 'websocket',
        'Origin': 'https://app.getgrass.io',
        'Sec-WebSocket-Version': '13',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      handshakeTimeout: 30000,
      maxPayload: 1024 * 1024
    };

    if (this.proxy) {
      options.agent = new HttpsProxyAgent(this.proxy);
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('wss://proxy2.wynd.network:4650', options);

      const timeout = setTimeout(() => {
        if (this.ws) {
          this.ws.terminate();
        }
        reject(new Error('Connection timeout'));
      }, 30000);

      this.ws.once('open', () => {
        clearTimeout(timeout);
        this.isReconnecting = false;
        logger.info(`Connected via proxy: ${this.proxy}`);
        resolve();
      });

      this.ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.action === 'UPDATE_MULTIPLIER') {
            this.pointsMultiplier = message.data.multiplier;
            logger.info(`Points Multiplier Updated: ${this.pointsMultiplier}x`);
          }
        } catch (error) {
          logger.error(`Failed to process message: ${error.message}`);
        }
      });

      this.ws.on('ping', () => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.pong();
        }
      });
    });
  }

  async authenticate() {
    return new Promise((resolve, reject) => {
      const authTimeout = setTimeout(() => {
        reject(new Error('Authentication timeout'));
      }, 30000);

      this.ws.once('message', async (data) => {
        clearTimeout(authTimeout);
        try {
          const response = JSON.parse(data.toString());
          await this.sendAuthPayload(response.id);
          logger.info('Authentication successful');
          resolve();
        } catch (error) {
          reject(new Error(`Authentication failed: ${error.message}`));
        }
      });
    });
  }

  async sendAuthPayload(authId) {
    const payload = {
      id: authId,
      origin_action: 'AUTH',
      result: {
        browser_id: this.browserId,
        user_id: this.userId,
        user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        timestamp: Math.floor(Date.now() / 1000),
        device_type: 'desktop',
        version: '4.28.1'
      }
    };
    await this.sendMessage(payload);
  }

  startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.lastPingTime = Date.now();
          await this.sendMessage({
            id: uuidv4(),
            action: 'PING',
            data: {}
          });

          await this.sendMessage({
            id: 'F3X',
            origin_action: 'PONG'
          });
          this.lastPongTime = Date.now();
        } catch (error) {
          logger.error(`Heartbeat failed: ${error.message}`);
          this.forceReconnect();
        }
      }
    }, 30000);
  }

  async sendMessage(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }

      this.ws.send(JSON.stringify(payload), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}
