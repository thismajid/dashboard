const { parentPort, workerData } = require('worker_threads');
const https = require('https');
const http = require('http');
const { URL } = require('url');

class ProxyWorker {
    constructor(config) {
        this.config = config;
        this.workingProxies = [];
        this.tested = 0;
        this.total = 0;
        this.failed = 0;
        this.startTime = Date.now();

        console.log('[ProxyWorker] Initialized with config:', {
            maxResponseTime: config.maxResponseTime,
            concurrency: config.concurrency,
            timeout: config.timeout,
            testUrl: config.testUrl
        });
    }

    async run() {
        try {
            console.log('[ProxyWorker] Starting proxy update process...');

            // دریافت لیست پروکسی‌ها از API
            const proxies = await this.fetchProxiesFromAPI();
            this.total = proxies.length;

            console.log(`[ProxyWorker] Fetched ${this.total} proxies from API`);

            if (this.total === 0) {
                throw new Error('No proxies received from API');
            }

            // تست پروکسی‌ها
            // await this.testProxies(proxies);

            // نمایش خلاصه نهایی
            this.showFinalSummary();

            // ارسال نتیجه نهایی
            parentPort.postMessage({
                type: 'completed',
                workingProxies: proxies,
                total: this.total,
                tested: this.tested,
                failed: this.failed
            });

        } catch (error) {
            console.error('[ProxyWorker] Error:', error);
            parentPort.postMessage({
                type: 'error',
                error: error.message
            });
        }
    }

    async fetchProxiesFromAPI() {
        return new Promise((resolve, reject) => {
            const apiUrl = `http://proxylist.space/?key=14vamdyyof&pack=2&clean&fast`;

            console.log('[ProxyWorker] Fetching from API...');

            const request = http.get(apiUrl, (response) => {
                let data = '';

                response.on('data', (chunk) => {
                    data += chunk;
                });

                response.on('end', () => {
                    try {
                        console.log(`[ProxyWorker] API Response length: ${data.length} characters`);
                        console.log(`[ProxyWorker] API Response preview: ${data.substring(0, 200)}...`);

                        const proxies = this.parseProxyList(data);
                        console.log(`[ProxyWorker] Parsed ${proxies.length} valid proxies from API response`);
                        resolve(proxies);
                    } catch (error) {
                        console.error('[ProxyWorker] Error parsing proxy list:', error);
                        reject(error);
                    }
                });
            });

            request.on('error', (error) => {
                console.error('[ProxyWorker] API request error:', error);
                reject(error);
            });

            request.setTimeout(30000, () => {
                console.error('[ProxyWorker] API request timeout');
                request.destroy();
                reject(new Error('API request timeout'));
            });
        });
    }

    parseProxyList(data) {
        const proxies = [];
        const lines = data.split('\n').filter(line => line.trim());

        console.log(`[ProxyWorker] Parsing ${lines.length} lines from API response`);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            try {
                // فرمت: host:port یا host:port:username:password
                const parts = line.split(':');

                if (parts.length >= 2) {
                    const proxy = {
                        host: parts[0].trim(),
                        port: parseInt(parts[1].trim()),
                        protocol: 'http'
                    };

                    // اگر username و password موجود باشد
                    if (parts.length >= 4) {
                        proxy.username = parts[2].trim();
                        proxy.password = parts[3].trim();
                    }

                    // بررسی صحت IP و Port
                    if (this.isValidIP(proxy.host) && proxy.port > 0 && proxy.port < 65536) {
                        proxies.push(proxy);

                        // نمایش چند نمونه اول
                        if (i < 5) {
                            console.log(`[ProxyWorker] Sample proxy ${i + 1}: ${proxy.host}:${proxy.port}`);
                        }
                    } else {
                        if (i < 5) {
                            console.log(`[ProxyWorker] Invalid proxy format: ${line}`);
                        }
                    }
                }
            } catch (error) {
                if (i < 5) {
                    console.error(`[ProxyWorker] Error parsing line ${i + 1}: ${line}`, error.message);
                }
            }
        }

        console.log(`[ProxyWorker] Successfully parsed ${proxies.length} valid proxies`);
        return proxies;
    }

    isValidIP(ip) {
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        return ipRegex.test(ip);
    }

    async testProxies(proxies) {
        console.log(`[ProxyWorker] ==================================================`);
        console.log(`[ProxyWorker] 🚀 STARTING PROXY TESTING`);
        console.log(`[ProxyWorker] 📊 Total proxies to test: ${proxies.length}`);
        console.log(`[ProxyWorker] 🔧 Concurrency: ${this.config.concurrency}`);
        console.log(`[ProxyWorker] ⏱️ Max response time: ${this.config.maxResponseTime}ms`);
        console.log(`[ProxyWorker] 🎯 Test URL: ${this.config.testUrl}`);
        console.log(`[ProxyWorker] ==================================================`);

        const chunks = this.chunkArray(proxies, this.config.concurrency);
        console.log(`[ProxyWorker] Split into ${chunks.length} chunks of ${this.config.concurrency} proxies each`);

        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
            const chunk = chunks[chunkIndex];
            console.log(`[ProxyWorker] 📦 Processing chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} proxies)`);

            const promises = chunk.map((proxy, index) =>
                this.testProxy(proxy, `${chunkIndex * this.config.concurrency + index + 1}`)
            );

            const results = await Promise.allSettled(promises);

            // شمارش نتایج این chunk
            let chunkWorking = 0;
            let chunkFailed = 0;

            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value === 'working') {
                    chunkWorking++;
                } else {
                    chunkFailed++;
                }
            });

            console.log(`[ProxyWorker] ✅ Chunk ${chunkIndex + 1} completed: ${chunkWorking} working, ${chunkFailed} failed`);

            // ارسال پیشرفت
            parentPort.postMessage({
                type: 'progress',
                tested: this.tested,
                total: this.total,
                working: this.workingProxies.length,
                failed: this.failed,
                chunk: chunkIndex + 1,
                totalChunks: chunks.length
            });

            // استراحت کوتاه بین chunks
            if (chunkIndex < chunks.length - 1) {
                await this.sleep(100);
            }
        }

        console.log(`[ProxyWorker] 🏁 All chunks processed!`);
    }

    async testProxy(proxy, proxyNumber) {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const timeoutId = setTimeout(() => {
                console.log(`[ProxyWorker] ⏰ #${proxyNumber} TIMEOUT: ${proxy.host}:${proxy.port}`);
                this.tested++;
                this.failed++;
                resolve('timeout');
            }, this.config.timeout);

            try {
                console.log(`[ProxyWorker] 🧪 #${proxyNumber} Testing: ${proxy.host}:${proxy.port}`);

                // ساخت درخواست HTTP به Sony از طریق پروکسی
                const options = {
                    hostname: proxy.host,
                    port: proxy.port,
                    method: 'CONNECT',
                    path: 'my.account.sony.com:443',
                    timeout: this.config.timeout,
                    headers: {
                        'Host': 'my.account.sony.com:443',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                };

                // اگر پروکسی نیاز به authentication دارد
                if (proxy.username && proxy.password) {
                    const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
                    options.headers['Proxy-Authorization'] = `Basic ${auth}`;
                    console.log(`[ProxyWorker] 🔐 #${proxyNumber} Using auth for: ${proxy.host}:${proxy.port}`);
                }

                const request = http.request(options);

                request.on('connect', (response, socket, head) => {
                    clearTimeout(timeoutId);
                    const responseTime = Date.now() - startTime;

                    socket.destroy(); // بستن connection

                    if (response.statusCode === 200 && responseTime <= this.config.maxResponseTime) {
                        proxy.responseTime = responseTime;
                        proxy.httpStatus = response.statusCode;

                        this.workingProxies.push(proxy);
                        console.log(`[ProxyWorker] ✅ #${proxyNumber} WORKING: ${proxy.host}:${proxy.port} (${responseTime}ms, Status: ${response.statusCode})`);

                        this.tested++;
                        resolve('working');
                    } else {
                        console.log(`[ProxyWorker] ❌ #${proxyNumber} SLOW/BAD: ${proxy.host}:${proxy.port} (${responseTime}ms, Status: ${response.statusCode})`);
                        this.tested++;
                        this.failed++;
                        resolve('failed');
                    }
                });

                request.on('error', (error) => {
                    clearTimeout(timeoutId);
                    console.log(`[ProxyWorker] ❌ #${proxyNumber} ERROR: ${proxy.host}:${proxy.port} - ${error.message}`);
                    this.tested++;
                    this.failed++;
                    resolve('error');
                });

                request.on('timeout', () => {
                    clearTimeout(timeoutId);
                    console.log(`[ProxyWorker] ⏰ #${proxyNumber} REQ_TIMEOUT: ${proxy.host}:${proxy.port}`);
                    request.destroy();
                    this.tested++;
                    this.failed++;
                    resolve('timeout');
                });

                // شروع درخواست
                request.end();

            } catch (error) {
                clearTimeout(timeoutId);
                console.log(`[ProxyWorker] ❌ #${proxyNumber} EXCEPTION: ${proxy.host}:${proxy.port} - ${error.message}`);
                this.tested++;
                this.failed++;
                resolve('exception');
            }
        });
    }

    showFinalSummary() {
        const totalTime = Date.now() - this.startTime;
        const successRate = this.total > 0 ? ((this.workingProxies.length / this.total) * 100).toFixed(2) : 0;

        console.log(`[ProxyWorker] ==================================================`);
        console.log(`[ProxyWorker] 📊 FINAL TEST SUMMARY:`);
        console.log(`[ProxyWorker] ⏱️ Total time: ${(totalTime / 1000).toFixed(2)}s`);
        console.log(`[ProxyWorker] 📈 Total tested: ${this.tested}/${this.total}`);
        console.log(`[ProxyWorker] ✅ Working (fast): ${this.workingProxies.length}`);
        console.log(`[ProxyWorker] ❌ Failed/Slow: ${this.failed}`);
        console.log(`[ProxyWorker] 📈 Success Rate: ${successRate}%`);
        console.log(`[ProxyWorker] ⚡ Avg response time: ${this.getAverageResponseTime()}ms`);
        console.log(`[ProxyWorker] ==================================================`);
    }

    getAverageResponseTime() {
        if (this.workingProxies.length === 0) return 0;

        const totalTime = this.workingProxies.reduce((sum, proxy) => sum + (proxy.responseTime || 0), 0);
        return Math.round(totalTime / this.workingProxies.length);
    }

    chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// اجرای worker
const worker = new ProxyWorker(workerData.config);
worker.run().catch(error => {
    console.error('[ProxyWorker] Fatal error:', error);
    parentPort.postMessage({
        type: 'error',
        error: error.message
    });

});
