const { parentPort, workerData } = require('worker_threads');
const http = require('http');

class ProxyWorker {
    constructor(config) {
        this.config = config;
        this.startTime = Date.now();

        console.log('[ProxyWorker] Initialized - Fetch only mode (no testing)');
    }

    async run() {
        try {
            console.log('[ProxyWorker] Starting proxy fetch process...');

            // دریافت لیست پروکسی‌ها از API
            const proxies = await this.fetchProxiesFromAPI();

            console.log(`[ProxyWorker] Fetched ${proxies.length} proxies from API`);

            if (proxies.length === 0) {
                throw new Error('No proxies received from API');
            }

            // نمایش خلاصه
            this.showSummary(proxies);

            // ارسال نتیجه نهایی - تمام پروکسی‌ها بدون تست
            parentPort.postMessage({
                type: 'completed',
                workingProxies: proxies, // تمام پروکسی‌ها
                total: proxies.length,
                tested: proxies.length,
                failed: 0
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
            const apiUrl = `http://proxylist.space/?key=${this.config.apiKey}&clean&fast`;

            console.log('[ProxyWorker] Fetching from API:', apiUrl.replace(this.config.apiKey, '***'));

            const request = http.get(apiUrl, (response) => {
                let data = '';

                response.on('data', (chunk) => {
                    data += chunk;
                });

                response.on('end', () => {
                    try {
                        console.log(`[ProxyWorker] API Response length: ${data.length} characters`);

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
                        protocol: 'http',
                        responseTime: 0, // مقدار پیش‌فرض
                        status: 'active',
                        source: 'api'
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
                        if (i < 3) {
                            console.log(`[ProxyWorker] Sample proxy ${i + 1}: ${proxy.host}:${proxy.port}${proxy.username ? ' (auth)' : ''}`);
                        }
                    } else {
                        if (i < 3) {
                            console.log(`[ProxyWorker] Invalid proxy format: ${line}`);
                        }
                    }
                }
            } catch (error) {
                if (i < 3) {
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

    showSummary(proxies) {
        const totalTime = Date.now() - this.startTime;
        const authProxies = proxies.filter(p => p.username && p.password).length;
        const noAuthProxies = proxies.length - authProxies;

        console.log(`[ProxyWorker] ==================================================`);
        console.log(`[ProxyWorker] 📊 FETCH SUMMARY:`);
        console.log(`[ProxyWorker] ⏱️ Total time: ${(totalTime / 1000).toFixed(2)}s`);
        console.log(`[ProxyWorker] 📈 Total proxies: ${proxies.length}`);
        console.log(`[ProxyWorker] 🔐 With auth: ${authProxies}`);
        console.log(`[ProxyWorker] 🔓 No auth: ${noAuthProxies}`);
        console.log(`[ProxyWorker] 🚀 Ready to save to database`);
        console.log(`[ProxyWorker] ==================================================`);
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