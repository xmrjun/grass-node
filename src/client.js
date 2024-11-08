import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.js';
import { Agent } from 'https';
import { ProxyManager } from './proxy-manager.js';

export class GrassClient {
  constructor(userId, proxy = null) {
    this.userId = userId;
    this.proxy = proxy;
    this.ws = null;
    this.browserId = uuidv4();
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
    this.isAuthenticated = false;
    this.connectionAttempts = 0;
    this.maxRetries = 20; // 增加重试次数以提高稳定性
    this.backoffDelay = 2000; // 初始重试延迟
    this.maxBackoffDelay = 60000; // 最大重试延迟
    this.isShuttingDown = false;
    this.proxyManager = new ProxyManager();
    this.lastConnectTime = 0;
    this.connectTimeout = 45000; // 增加连接超时时间
    this.successfulConnections = 0;
  }

  async start() {
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    
    while (!this.isShuttingDown) {
      try {
        // 检查代理可用性
        if (!this.proxyManager.isProxyViable(this.proxy)) {
          logger.warn(`Proxy ${this.proxy} is currently blocked, waiting for cooldown...`);
          await new Promise(resolve => setTimeout(resolve, this.maxBackoffDelay));
          continue;
        }

        // 连接限制检查
        const now = Date.now();
        const timeSinceLastConnect = now - this.lastConnectTime;
        if (timeSinceLastConnect < 5000) {
          await new Promise(resolve => setTimeout(resolve, 5000 - timeSinceLastConnect));
        }
        this.lastConnectTime = now;

        await this.connect();
        await this.authenticate();
        this.startHeartbeat();
        
        this.successfulConnections++;
        this.connectionAttempts = 0;
        this.proxyManager.trackProxyStatus(this.proxy, true);

        // 等待连接关闭
        await new Promise((resolve) => {
          this.ws.once('close', () => {
            logger.warn(`Connection closed for proxy: ${this.proxy}`);
            resolve();
          });
        });

      } catch (error) {
        this.connectionAttempts++;
        this.proxyManager.trackProxyStatus(this.proxy, false);
        
        const delay = Math.min(this.backoffDelay * Math.pow(1.5, this.connectionAttempts - 1), this.maxBackoffDelay);
        
        if (error.message.includes('404')) {
          logger.error(`Server endpoint not found (404). Waiting longer before retry...`);
          await new Promise(resolve => setTimeout(resolve, this.maxBackoffDelay));
        } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
          logger.error(`Network error (${error.code}). Retrying in ${Math.floor(delay/1000)}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          logger.error(`Connection error (attempt ${this.connectionAttempts}): ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } finally {
        this.cleanup();
      }
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
      timeout: this.connectTimeout,
      followRedirects: true,
      maxPayload: 1024 * 1024,
      rejectUnauthorized: false,
      agent: new Agent({
        rejectUnauthorized: false,
        keepAlive: true,
        keepAliveMsecs: 30000,
        timeout: this.connectTimeout
      })
    };

    if (this.proxy) {
      options.proxy = this.proxy;
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket('wss://proxy2.wynd.network:4650', options);

        const connectionTimeout = setTimeout(() => {
          if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
            this.ws.terminate();
            reject(new Error('Connection timeout'));
          }
        }, this.connectTimeout);

        this.ws.once('open', () => {
          clearTimeout(connectionTimeout);
          logger.info(`Connected via proxy: ${this.proxy}`);
          resolve();
        });

        this.ws.once('error', (error) => {
          clearTimeout(connectionTimeout);
          reject(error);
        });

        this.ws.on('unexpected-response', (request, response) => {
          clearTimeout(connectionTimeout);
          reject(new Error(`Unexpected server response: ${response.statusCode}`));
        });

        // 处理 ping/pong
        this.ws.on('ping', () => {
          try {
            this.ws.pong();
          } catch (error) {
            logger.error(`Failed to send pong: ${error.message}`);
          }
        });

      } catch (error) {
        reject(error);
      }
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
          this.isAuthenticated = true;
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
          await this.sendMessage({
            id: uuidv4(),
            action: 'PING',
            data: {}
          });

          await this.sendMessage({
            id: 'F3X',
            origin_action: 'PONG'
          });
        } catch (error) {
          logger.error(`Heartbeat failed: ${error.message}`);
          this.cleanup();
        }
      }
    }, 30000);
  }

  async sendMessage(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }

      const timeout = setTimeout(() => {
        reject(new Error('Send message timeout'));
      }, 10000);

      this.ws.send(JSON.stringify(payload), (error) => {
        clearTimeout(timeout);
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

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.isAuthenticated = false;
  }

  shutdown() {
    this.isShuttingDown = true;
    this.cleanup();
    logger.info('Client shutdown initiated');
  }
}
