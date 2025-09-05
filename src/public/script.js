// متغیرهای سراسری
let socket = null;
let reconnectAttempts = 0;
let statsUpdateInterval = null;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', function () {
    console.log('📊 Dashboard script loaded successfully');
    initializeDashboard();
});

function initializeDashboard() {
    console.log('🚀 Dashboard initializing...');

    // Initialize components
    initializeSocket();
    initializeEventListeners();
    initializeCharts();

    // Set up periodic stats request
    statsUpdateInterval = setInterval(() => {
        if (socket && socket.connected) {
            console.log('📊 Periodic stats request...');
            socket.emit('request-stats');
        }
    }, 5000); // هر 5 ثانیه

    console.log('✅ Dashboard initialized');
}

// Socket initialization
function initializeSocket() {
    try {
        socket = io('/dashboard', {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            timeout: 20000,
            forceNew: true
        });

        socket.on('connect', () => {
            console.log('✅ Connected to server');
            updateConnectionStatus('connected', 'متصل به سرور');
            setTimeout(() => socket.emit('request-stats'), 100);
        });

        socket.on('disconnect', (reason) => {
            console.log('❌ Disconnected:', reason);
            updateConnectionStatus('disconnected', 'قطع اتصال');
        });

        socket.on('stats-update', handleStatsUpdate);
        socket.on('proxy-update-status', handleProxyUpdateStatus);
        socket.on('notification', (data) => showNotification(data.message, data.type || 'info'));

    } catch (error) {
        console.error('❌ Socket initialization failed:', error);
        updateConnectionStatus('disconnected', 'خطا در اتصال');
    }
}

// تابع جدید برای درخواست دستی آمار
function requestStats() {
    if (socket && socket.connected) {
        console.log('📊 Manual stats request...');
        socket.emit('request-stats');
    } else {
        console.error('❌ Socket not connected');

        // تلاش برای دریافت از API
        fetchStatsViaAPI();
    }
}

// تابع جدید برای دریافت آمار از طریق API (fallback)
async function fetchStatsViaAPI() {
    try {
        console.log('📊 Fetching stats via API...');

        const response = await fetch('/api/stats/test');
        const data = await response.json();

        console.log('📊 API Response:', data);

        if (data.success && data.data) {
            // تبدیل داده‌های API به فرمت مورد نظر
            const stats = {
                system: {
                    accounts: {
                        total: data.data.directCounts.accounts,
                        pending: data.data.directCounts.pendingAccounts,
                        processing: 0,
                        completed: 0,
                        failed: 0,
                        results: {
                            good: 0, bad: 0, invalid: 0, '2fa': 0, passkey: 0,
                            error: 0, lock: 0, guard: 0, 'change-pass': 0,
                            'mobile-2step': 0, timeout: 0, 'server-error': 0
                        }
                    },
                    proxies: {
                        total: data.data.directCounts.proxies,
                        active: data.data.directCounts.proxies,
                        available: data.data.directCounts.proxies,
                        used: 0,
                        failed: 0,
                        avgResponseTime: 0,
                        successRate: 100,
                        lastUpdate: new Date()
                    }
                },
                instances: { totalInstances: 0, activeInstances: 0 },
                timestamp: Date.now()
            };

            console.log('📊 Formatted stats:', stats);
            handleStatsUpdate(stats);
        }

    } catch (error) {
        console.error('❌ API fetch error:', error);
        showNotification('خطا در دریافت آمار', 'error');
    }
}

// Handle stats update
function handleStatsUpdate(data) {
    if (!data) return;
    console.log('📊 Stats update received:', data);

    if (data.system) {
        updateSystemStats(data.system);
        updateAccountDetails(data.system.accounts); // اضافه کردن این خط
    }
    if (data.proxyService) updateProxyServiceStatus(data.proxyService);
    if (data.instances) updateInstanceStats(data.instances);
}

function updateProxyDetails(proxyStats) {
    console.log('🌐 Updating proxy details:', proxyStats);

    updateElement('total-proxies-detail', proxyStats.total || 0);
    updateElement('active-proxies-detail', proxyStats.active || proxyStats.total || 0);
    updateElement('avg-proxy-response', `${proxyStats.avgResponseTime || 0}ms`);
    updateElement('proxy-success-rate', `${proxyStats.successRate || 100}%`);

    // آپدیت زمان آخرین به‌روزرسانی
    if (proxyStats.lastUpdate) {
        const lastUpdate = formatDateTime(new Date(proxyStats.lastUpdate));
        updateElement('proxy-last-update', lastUpdate);
    } else {
        updateElement('proxy-last-update', 'هرگز');
    }

    // آپدیت زمان به‌روزرسانی بعدی
    if (proxyStats.nextUpdate) {
        const nextUpdate = formatDateTime(new Date(proxyStats.nextUpdate));
        updateElement('proxy-next-update', nextUpdate);
    } else {
        updateElement('proxy-next-update', 'نامشخص');
    }
}

function updateSystemStats(system) {
    console.log('📊 Updating system stats:', system);

    // آمار کلی
    updateElement('total-accounts', system.accounts?.total || 0);
    updateElement('processed-accounts', system.accounts?.completed || 0);
    updateElement('pending-count', system.accounts?.pending || 0);
    updateElement('processing-count', system.accounts?.processing || 0);

    // آمار پروکسی - فقط تعداد کل
    updateElement('active-proxies', system.proxies?.total || 0);

    // آمار عملکرد
    updateElement('success-rate', `${system.accounts?.successRate || 0}%`);
    updateElement('avg-response-time', `${system.proxies?.avgResponseTime || 0}ms`);
    updateElement('memory-usage', `${system.system?.memory?.used || 0} MB`);

    // آمار instance ها
    if (system.instances) {
        updateElement('active-instances', system.instances.active || 0);
        updateElement('running-instances', system.instances.active || 0);
        updateElement('connected-instances', system.instances.total || 0);
    }

    // آمار batch ها
    if (system.batches) {
        updateElement('total-batches', system.batches.total || 0);
        updateElement('completed-batches', system.batches.completed || 0);
    }

    // آپدیت جزئیات پروکسی در بخش جداگانه
    updateProxyDetails(system.proxies || {});

    // آپدیت footer
    updateElement('footer-pending', system.accounts?.pending || 0);
    updateElement('footer-processing', system.accounts?.processing || 0);
    updateElement('footer-completed', system.accounts?.completed || 0);

    // آپدیت اطلاعات سیستم
    if (system.system) {
        updateSystemInfo(system.system);
    }
}


// تابع برای آپدیت وضعیت سرویس پروکسی
function updateProxyServiceStatus(proxyService) {
    try {
        console.log('🌐 Updating proxy service status:', proxyService);

        if (!proxyService) {
            console.warn('⚠️ No proxy service data');
            return;
        }

        // آپدیت وضعیت سرویس
        const statusElement = document.getElementById('proxy-service-status');
        if (statusElement) {
            if (proxyService.isRunning) {
                statusElement.innerHTML = '<span class="badge badge-success"><i class="fas fa-check-circle"></i> فعال</span>';
            } else {
                statusElement.innerHTML = '<span class="badge badge-danger"><i class="fas fa-times-circle"></i> غیرفعال</span>';
            }
        }

        // آپدیت زمان‌ها
        if (proxyService.lastUpdate) {
            const lastUpdateTime = formatDateTime(new Date(proxyService.lastUpdate));
            updateElement('proxy-last-update', lastUpdateTime);
        }

        if (proxyService.nextUpdate) {
            const nextUpdateTime = formatDateTime(new Date(proxyService.nextUpdate));
            updateElement('proxy-next-update', nextUpdateTime);
        }

        // آپدیت وضعیت آپدیت
        const updateStatusElement = document.getElementById('proxy-update-status');
        if (updateStatusElement && proxyService.status) {
            switch (proxyService.status) {
                case 'updating':
                    updateStatusElement.innerHTML = '<span class="badge badge-warning"><i class="fas fa-spinner fa-spin"></i> در حال به‌روزرسانی</span>';
                    break;
                case 'success':
                    updateStatusElement.innerHTML = '<span class="badge badge-success"><i class="fas fa-check"></i> موفق</span>';
                    break;
                case 'error':
                    updateStatusElement.innerHTML = '<span class="badge badge-danger"><i class="fas fa-exclamation-triangle"></i> خطا</span>';
                    break;
                default:
                    updateStatusElement.innerHTML = '<span class="badge badge-info"><i class="fas fa-info-circle"></i> آماده</span>';
            }
        }

    } catch (error) {
        console.error('❌ Error updating proxy service status:', error);
    }
}

// تابع برای آپدیت وضعیت سرویس پروکسی
function updateProxyServiceStatus(proxyService) {
    try {
        console.log('🌐 Updating proxy service status:', proxyService);

        if (!proxyService) {
            console.warn('⚠️ No proxy service data');
            return;
        }

        // آپدیت وضعیت سرویس
        const statusElement = document.getElementById('proxy-service-status');
        if (statusElement) {
            if (proxyService.isRunning) {
                statusElement.innerHTML = '<span class="badge badge-success"><i class="fas fa-check-circle"></i> فعال</span>';
            } else {
                statusElement.innerHTML = '<span class="badge badge-danger"><i class="fas fa-times-circle"></i> غیرفعال</span>';
            }
        }

        // آپدیت زمان‌ها
        if (proxyService.lastUpdate) {
            const lastUpdateTime = formatDateTime(new Date(proxyService.lastUpdate));
            updateElement('proxy-last-update', lastUpdateTime);
        }

        if (proxyService.nextUpdate) {
            const nextUpdateTime = formatDateTime(new Date(proxyService.nextUpdate));
            updateElement('proxy-next-update', nextUpdateTime);
        }

        // آپدیت وضعیت آپدیت
        const updateStatusElement = document.getElementById('proxy-update-status');
        if (updateStatusElement && proxyService.status) {
            switch (proxyService.status) {
                case 'updating':
                    updateStatusElement.innerHTML = '<span class="badge badge-warning"><i class="fas fa-spinner fa-spin"></i> در حال به‌روزرسانی</span>';
                    break;
                case 'success':
                    updateStatusElement.innerHTML = '<span class="badge badge-success"><i class="fas fa-check"></i> موفق</span>';
                    break;
                case 'error':
                    updateStatusElement.innerHTML = '<span class="badge badge-danger"><i class="fas fa-exclamation-triangle"></i> خطا</span>';
                    break;
                default:
                    updateStatusElement.innerHTML = '<span class="badge badge-info"><i class="fas fa-info-circle"></i> آماده</span>';
            }
        }

    } catch (error) {
        console.error('❌ Error updating proxy service status:', error);
    }
}

// تابع برای آپدیت اطلاعات سیستم
function updateSystemInfo(systemInfo) {
    try {
        console.log('💻 Updating system info:', systemInfo);

        if (systemInfo.uptime) {
            updateElement('system-uptime', formatUptime(systemInfo.uptime));
        }

        if (systemInfo.memory) {
            const memoryText = `${systemInfo.memory.used}/${systemInfo.memory.total} MB (${systemInfo.memory.usage}%)`;
            updateElement('memory-usage-detail', memoryText);
        }

        if (systemInfo.nodeVersion) {
            updateElement('node-version', systemInfo.nodeVersion);
        }

        if (systemInfo.environment) {
            updateElement('environment', systemInfo.environment);
        }

    } catch (error) {
        console.error('❌ Error updating system info:', error);
    }
}

// تابع برای فرمت کردن uptime
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
        return `${days} روز، ${hours} ساعت`;
    } else if (hours > 0) {
        return `${hours} ساعت، ${minutes} دقیقه`;
    } else {
        return `${minutes} دقیقه`;
    }
}

// اضافه کردن event listener برای دکمه به‌روزرسانی پروکسی
function initializeEventListeners() {
    // Refresh button
    const refreshBtn = document.querySelector('.refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            console.log('🔄 Refresh button clicked');
            requestStats();
        });
    }

    // دکمه به‌روزرسانی پروکسی
    const updateProxiesBtn = document.getElementById('update-proxies-btn');
    if (updateProxiesBtn) {
        updateProxiesBtn.addEventListener('click', async () => {
            console.log('🔄 Update proxies button clicked');

            updateProxiesBtn.disabled = true;
            updateProxiesBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> در حال به‌روزرسانی...';

            try {
                if (socket && socket.connected) {
                    socket.emit('update-proxies');
                } else {
                    // استفاده از API
                    const response = await fetch('/api/proxies/update', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    });

                    const result = await response.json();

                    if (result.success) {
                        showNotification('به‌روزرسانی پروکسی‌ها آغاز شد', 'success');
                    } else {
                        throw new Error(result.message);
                    }
                }
            } catch (error) {
                console.error('❌ Error updating proxies:', error);
                showNotification(`خطا در به‌روزرسانی: ${error.message}`, 'error');
            } finally {
                updateProxiesBtn.disabled = false;
                updateProxiesBtn.innerHTML = '<i class="fas fa-sync-alt"></i> به‌روزرسانی';
            }
        });
    }

    // Upload functionality
    initializeUpload();

    // Instance controls
    initializeInstanceControls();
}

// Handle proxy update status
function handleProxyUpdateStatus(data) {
    try {
        console.log('🌐 Proxy update status:', data);

        const statusBadge = document.getElementById('proxy-update-status');
        if (statusBadge) {
            switch (data.status) {
                case 'updating':
                    statusBadge.innerHTML = '<span class="badge badge-warning"><i class="fas fa-spinner fa-spin"></i> در حال به‌روزرسانی...</span>';
                    break;
                case 'success':
                    statusBadge.innerHTML = '<span class="badge badge-success"><i class="fas fa-check"></i> به‌روزرسانی شد</span>';
                    if (data.stats) {
                        showNotification(`${data.stats.active || data.stats.total} پروکسی بارگذاری شد`, 'success');
                    }
                    break;
                case 'error':
                    statusBadge.innerHTML = '<span class="badge badge-danger"><i class="fas fa-exclamation-triangle"></i> خطا در به‌روزرسانی</span>';
                    showNotification(data.message || 'خطا در به‌روزرسانی پروکسی‌ها', 'error');
                    break;
            }
        }

        // آپدیت آمار اگر ارائه شده باشد
        if (data.stats) {
            updateElement('total-proxies', data.stats.total || 0);
            updateElement('active-proxies', data.stats.active || 0);
            updateElement('total-proxies-detail', data.stats.total || 0);
            updateElement('active-proxies-detail', data.stats.active || 0);
        }

    } catch (error) {
        console.error('❌ Error handling proxy update status:', error);
    }
}

function updateAccountDetails(accounts) {
    console.log('📊 Updating account details:', accounts);

    if (!accounts || !accounts.results) {
        console.warn('⚠️ No account results data');
        return;
    }

    const results = accounts.results;

    // آپدیت هر نوع نتیجه
    updateElement('good-count', results.good || 0);
    updateElement('invalid-count', results.invalid || 0);
    updateElement('twofa-count', results['2fa'] || 0);
    updateElement('passkey-count', results.passkey || 0);
    updateElement('error-count', results.error || 0);
    updateElement('lock-count', results.lock || 0);
    updateElement('guard-count', results.guard || 0);
    updateElement('change-pass-count', results['change-pass'] || 0);
    updateElement('mobile-2step-count', results['mobile-2step'] || 0);
    updateElement('timeout-count', results.timeout || 0);
    updateElement('server-error-count', results['server-error'] || 0);

    // محاسبه Bad count (جمع همه جز Good)
    const badCount = (results.invalid || 0) +
        (results['2fa'] || 0) +
        (results.passkey || 0) +
        (results.error || 0) +
        (results.lock || 0) +
        (results.guard || 0) +
        (results['change-pass'] || 0) +
        (results['mobile-2step'] || 0) +
        (results.timeout || 0) +
        (results['server-error'] || 0);

    updateElement('bad-count', badCount);

    console.log('📊 Account details updated:', {
        good: results.good || 0,
        bad: badCount,
        total: accounts.total || 0
    });
}



const mapping = {
    'processing-count': 'processed-accounts', // یا اگر بخوای جدید براش بسازی اینو حذف کن
    '2fa-count': 'twofa-count',
    'changepass-count': 'change-pass-count',
    'mobile2step-count': 'mobile-2step-count',
    'servererror-count': 'server-error-count',
    'total-instances': 'active-instances', // یا 'running-instances'
    'last-update-time': 'last-update'
};

function updateElement(id, value) {
    const el = document.getElementById(id);
    if (el) {
        // اگر مقدار تغییر کرده باشد، انیمیشن اعمال کن
        if (el.textContent !== value.toString()) {
            el.textContent = value;
            el.classList.add('value-updated');
            setTimeout(() => el.classList.remove('value-updated'), 1000);
        }
    } else {
        console.warn(`⚠️ Element with ID '${id}' not found`);
    }
}

// Event listeners
function initializeEventListeners() {
    // Refresh button
    const refreshBtn = document.querySelector('.refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            console.log('🔄 Refresh button clicked');
            requestStats();
        });
    }

    // Upload functionality
    initializeUpload();

    // Instance controls
    initializeInstanceControls();
}

function initializeUpload() {
    console.log('📤 Initializing HTTP upload...');

    const uploadArea = document.getElementById('upload-area');
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const uploadForm = document.getElementById('upload-form');

    if (!uploadArea || !fileInput || !uploadBtn) {
        console.error('❌ Upload elements not found!');
        return;
    }

    // کلیک روی منطقه آپلود
    uploadArea.addEventListener('click', () => fileInput.click());

    // درگ کردن
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            fileInput.files = e.dataTransfer.files;
            handleFileSelect(e.dataTransfer.files[0]);
        }
    });

    // انتخاب فایل
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFileSelect(e.target.files[0]);
    });

    // فرم
    uploadForm.addEventListener('submit', (e) => {
        e.preventDefault();
        handleUploadHTTP();
    });
}

function handleFileSelect(file) {
    console.log('📄 File selected:', file.name, 'Size:', file.size);
    const validExtensions = ['.txt', '.csv', '.json'];
    const fileExt = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

    if (!validExtensions.includes(fileExt)) {
        showNotification('فرمت فایل باید txt, csv یا json باشد', 'error');
        return;
    }
    if (file.size > 50 * 1024 * 1024) {
        showNotification('حجم فایل بیش از 50 مگابایت است', 'error');
        return;
    }

    document.getElementById('upload-btn').disabled = false;
    document.querySelector('#upload-area .upload-text').innerHTML = `
        <p><i class="fas fa-file"></i> ${file.name}</p>
        <small>حجم: ${formatFileSize(file.size)}</small>
    `;
}

async function handleUploadHTTP() {
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const uploadProgress = document.getElementById('upload-progress');
    const uploadResult = document.getElementById('upload-result');

    if (!fileInput.files[0]) {
        showNotification('لطفاً یک فایل انتخاب کنید', 'warning');
        return;
    }

    const file = fileInput.files[0];
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> در حال آپلود...';
    uploadProgress.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = 'شروع آپلود...';

    try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        console.log('📥 Server upload response:', result);

        if (result.success) {
            progressFill.style.width = '100%';
            progressText.textContent = 'آپلود کامل شد';
            uploadResult.style.display = 'block';
            uploadResult.className = 'upload-result success';
            uploadResult.innerHTML = `<i class="fas fa-check-circle"></i> ${result.count} اکانت با موفقیت آپلود شد`;
            showNotification('آپلود موفق بود', 'success');
            resetUploadForm();
            if (socket && socket.connected) socket.emit('request-stats');

        } else {
            throw new Error(result.message || 'خطا در آپلود');
        }

    } catch (err) {
        console.error('❌ Upload error:', err);
        progressText.textContent = 'خطا در آپلود';
        uploadResult.style.display = 'block';
        uploadResult.className = 'upload-result error';
        uploadResult.innerHTML = `<i class="fas fa-times-circle"></i> ${err.message}`;
        showNotification(`خطا: ${err.message}`, 'error');

    } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = '<i class="fas fa-upload"></i> آپلود فایل';
    }
}


async function handleUpload() {
    console.log('📤 Starting upload...');

    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const uploadProgress = document.getElementById('upload-progress');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const uploadResult = document.getElementById('upload-result');

    if (!fileInput.files[0]) {
        showNotification('لطفاً یک فایل انتخاب کنید', 'warning');
        return;
    }

    const file = fileInput.files[0];

    // Disable upload button
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> در حال آپلود...';

    // Show progress
    uploadProgress.style.display = 'block';
    uploadResult.style.display = 'none';

    // Reset progress
    progressFill.style.width = '0%';
    progressText.textContent = 'در حال خواندن فایل...';

    try {
        // Read file content
        const content = await readFileContent(file);
        const lines = content.split('\n').filter(line => line.trim());

        console.log(`📄 File loaded: ${lines.length} lines`);
        progressText.textContent = `${lines.length} خط یافت شد`;

        // Parse accounts based on file type
        const accounts = parseAccounts(file.name, lines);

        console.log(`📊 Parsed ${accounts.length} valid accounts`);

        if (accounts.length === 0) {
            throw new Error('هیچ اکانت معتبری در فایل یافت نشد');
        }

        // Update progress
        progressFill.style.width = '50%';
        progressText.textContent = `در حال ارسال ${accounts.length} اکانت...`;

        // Send via socket or HTTP
        if (socket && socket.connected) {
            // Send via socket
            await sendViaSocket(accounts, file.name);
        } else {
            // Send via HTTP
            await sendViaHTTP(file);
        }

        // Success
        progressFill.style.width = '100%';
        progressText.textContent = 'آپلود با موفقیت انجام شد';

        // Show result
        showUploadResult({
            success: true,
            count: accounts.length,
            fileName: file.name
        });

        // Reset form after delay
        setTimeout(() => {
            resetUploadForm();
        }, 3000);

    } catch (error) {
        console.error('❌ Upload error:', error);
        showNotification(`خطا در آپلود: ${error.message}`, 'error');
        showUploadResult({
            success: false,
            error: error.message
        });
        resetUploadForm();
    }
}

// Read file content
function readFileContent(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(new Error('خطا در خواندن فایل'));

        reader.readAsText(file);
    });
}

// Parse accounts based on file type
function parseAccounts(fileName, lines) {
    const accounts = [];
    const fileExtension = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();

    if (fileExtension === '.json') {
        // Parse JSON
        try {
            const jsonData = JSON.parse(lines.join('\n'));
            if (Array.isArray(jsonData)) {
                jsonData.forEach(item => {
                    if (item.email && item.password) {
                        accounts.push({
                            email: item.email.trim(),
                            password: item.password.trim()
                        });
                    }
                });
            }
        } catch (e) {
            console.error('Invalid JSON format');
        }
    } else {
        // Parse TXT/CSV
        lines.forEach((line, index) => {
            const trimmedLine = line.trim();
            if (!trimmedLine) return;

            // Support both : and , as separators
            const separator = trimmedLine.includes(':') ? ':' : ',';
            const parts = trimmedLine.split(separator);

            if (parts.length >= 2) {
                const email = parts[0].trim();
                const password = parts[1].trim();

                // Basic email validation
                if (email.includes('@') && password.length > 0) {
                    accounts.push({ email, password });
                } else {
                    console.log(`Line ${index + 1} invalid format: ${trimmedLine}`);
                }
            }
        });
    }

    return accounts;
}

// Send via socket
function sendViaSocket(accounts, fileName) {
    return new Promise((resolve, reject) => {
        console.log('📡 Sending via WebSocket...');

        // Listen for response
        const timeout = setTimeout(() => {
            socket.off('upload-complete');
            socket.off('upload-error');
            reject(new Error('Timeout waiting for server response'));
        }, 30000);

        socket.once('upload-complete', (data) => {
            clearTimeout(timeout);
            console.log('✅ Upload complete:', data);
            resolve(data);
        });

        socket.once('upload-error', (data) => {
            clearTimeout(timeout);
            console.error('❌ Upload error:', data);
            reject(new Error(data.message || 'Upload failed'));
        });

        // Send accounts
        socket.emit('upload-accounts', {
            accounts: accounts,
            fileName: fileName,
            totalCount: accounts.length,
            timestamp: Date.now()
        });

        console.log(`📤 Sent ${accounts.length} accounts via socket`);
    });
}

// Send via HTTP
async function sendViaHTTP(file) {
    console.log('📤 Sending via HTTP...');

    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
        throw new Error(result.message || 'Upload failed');
    }

    return result.data;
}

// Show upload result
function showUploadResult(result) {
    const uploadResult = document.getElementById('upload-result');

    if (result.success) {
        uploadResult.className = 'upload-result success';
        uploadResult.innerHTML = `
 <i class="fas fa-check-circle"></i>
 <strong>آپلود موفق!</strong>
 <p>${result.count} اکانت از فایل ${result.fileName} با موفقیت آپلود شد</p>
 `;
    } else {
        uploadResult.className = 'upload-result error';
        uploadResult.innerHTML = `
 <i class="fas fa-times-circle"></i>
 <strong>خطا در آپلود</strong>
 <p>${result.error}</p>
 `;
    }

    uploadResult.style.display = 'block';
}

// Reset upload form
function resetUploadForm() {
    const uploadArea = document.getElementById('upload-area');
    const fileInput = document.getElementById('file-input');
    fileInput.value = '';
    uploadArea.classList.remove('file-selected');
    document.querySelector('#upload-area .upload-text').innerHTML = `
        <p>فایل خود را اینجا بکشید یا کلیک کنید</p>
        <small>فرمت‌های پشتیبانی شده: TXT, CSV, JSON (حداکثر 50MB)</small>
    `;
}

// Format file size
function formatFileSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB'];
    if (bytes === 0) return '0 Bytes';
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)), 10);
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

// Initialize instance controls
function initializeInstanceControls() {
    console.log('🎮 Initializing instance controls...');

    // Start all button
    const startAllBtn = document.getElementById('start-all-btn');
    if (startAllBtn) {
        startAllBtn.addEventListener('click', () => {
            if (socket && socket.connected) {
                socket.emit('start-all-instances');
                showNotification('درخواست شروع همه instance ها ارسال شد', 'info');
            } else {
                showNotification('اتصال برقرار نیست', 'error');
            }
        });
    }

    // Stop all button
    const stopAllBtn = document.getElementById('stop-all-btn');
    if (stopAllBtn) {
        stopAllBtn.addEventListener('click', () => {
            if (socket && socket.connected) {
                socket.emit('stop-all-instances');
                showNotification('درخواست توقف همه instance ها ارسال شد', 'warning');
            } else {
                showNotification('اتصال برقرار نیست', 'error');
            }
        });
    }
}

// Add CSS for animation
const style = document.createElement('style');
style.textContent = `
 .value-updated {
 animation: highlight 1s ease-in-out;
 }
 
 @keyframes highlight {
 0% { background-color: transparent; }
 50% { background-color: #4CAF50; color: white; }
 100% { background-color: transparent; }
 }
`;
document.head.appendChild(style);

// اضافه کنید بعد از updateSystemStats function:

// Update instance stats
function updateInstanceStats(instances) {
    try {
        console.log('📊 Updating instance stats:', instances);

        if (!instances) {
            console.warn('⚠️ No instance data');
            return;
        }

        // Update total instances
        updateElement('total-instances', instances.totalInstances || 0);
        updateElement('active-instances', instances.activeInstances || 0);

        // Update instance list
        updateInstanceList(instances.instances || []);

    } catch (error) {
        console.error('❌ Error updating instance stats:', error);
    }
}

// Update proxy service status
function updateProxyServiceStatus(proxyService) {
    try {
        console.log('🌐 Updating proxy service status:', proxyService);

        if (!proxyService) {
            console.warn('⚠️ No proxy service data');
            return;
        }

        // Update proxy service status indicator
        const statusElement = document.getElementById('proxy-service-status');
        if (statusElement) {
            if (proxyService.isRunning) {
                statusElement.innerHTML = '<span class="badge badge-success">فعال</span>';
            } else {
                statusElement.innerHTML = '<span class="badge badge-danger">غیرفعال</span>';
            }
        }

        // Update last update time
        if (proxyService.lastUpdate) {
            const lastUpdateTime = formatDateTime(new Date(proxyService.lastUpdate));
            updateElement('proxy-last-update', lastUpdateTime);
        }

        // Update next update time
        if (proxyService.nextUpdate) {
            const nextUpdateTime = formatDateTime(new Date(proxyService.nextUpdate));
            updateElement('proxy-next-update', nextUpdateTime);
        }

    } catch (error) {
        console.error('❌ Error updating proxy service status:', error);
    }
}

// Update instance list
function updateInstanceList(instances) {
    try {
        const listContainer = document.getElementById('instance-list');
        if (!listContainer) {
            console.log('Instance list container not found');
            return;
        }

        if (instances.length === 0) {
            listContainer.innerHTML = `
 <div class="text-center text-muted p-4">
 <i class="fas fa-server fa-3x mb-3"></i>
 <p>هیچ instance فعالی وجود ندارد</p>
 </div>
 `;
            return;
        }

        // Create instance cards
        const instancesHTML = instances.map(instance => `
 <div class="col-md-6 col-lg-4 mb-3">
 <div class="card instance-card ${instance.status === 'active' ? 'border-success' : 'border-secondary'}">
 <div class="card-body">
 <h6 class="card-title">
 <i class="fas fa-server"></i> ${instance.instanceId}
 </h6>
 <div class="instance-stats">
 <small class="text-muted">وضعیت:</small>
 <span class="badge badge-${instance.status === 'active' ? 'success' : 'secondary'}">
 ${instance.status === 'active' ? 'فعال' : 'غیرفعال'}
 </span>
 </div>
 <div class="instance-stats mt-2">
 <small class="text-muted">پردازش شده:</small>
 <strong>${instance.processed || 0}</strong>
 </div>
 <div class="instance-actions mt-3">
 <button class="btn btn-sm btn-primary" onclick="controlInstance('${instance.instanceId}', 'start')">
 <i class="fas fa-play"></i>
 </button>
 <button class="btn btn-sm btn-danger" onclick="controlInstance('${instance.instanceId}', 'stop')">
 <i class="fas fa-stop"></i>
 </button>
 </div>
 </div>
 </div>
 </div>
 `).join('');

        listContainer.innerHTML = instancesHTML;

    } catch (error) {
        console.error('❌ Error updating instance list:', error);
    }
}

// Update last update time
function updateLastUpdateTime() {
    try {
        const now = new Date();
        const timeString = formatDateTime(now);
        updateElement('last-update-time', timeString);
    } catch (error) {
        console.error('❌ Error updating last update time:', error);
    }
}

// Format date time
function formatDateTime(date) {
    if (!date || !(date instanceof Date)) {
        return 'نامشخص';
    }

    const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };

    return new Intl.DateTimeFormat('fa-IR', options).format(date);
}

// Control instance
function controlInstance(instanceId, action) {
    console.log(`🎮 Controlling instance ${instanceId}: ${action}`);

    if (socket && socket.connected) {
        socket.emit(`${action}-instance`, { instanceId });
        showNotification(`درخواست ${action} برای ${instanceId} ارسال شد`, 'info');
    } else {
        showNotification('اتصال برقرار نیست', 'error');
    }
}

// Handle proxy update status
function handleProxyUpdateStatus(data) {
    try {
        console.log('🌐 Proxy update status:', data);

        const statusBadge = document.getElementById('proxy-update-status');
        if (statusBadge) {
            switch (data.status) {
                case 'updating':
                    statusBadge.innerHTML = '<span class="badge badge-warning">در حال به‌روزرسانی...</span>';
                    break;
                case 'success':
                    statusBadge.innerHTML = '<span class="badge badge-success">به‌روزرسانی شد</span>';
                    if (data.stats) {
                        showNotification(`${data.stats.active} پروکسی فعال یافت شد`, 'success');
                    }
                    break;
                case 'error':
                    statusBadge.innerHTML = '<span class="badge badge-danger">خطا در به‌روزرسانی</span>';
                    break;
            }
        }

        // Update stats if provided
        if (data.stats) {
            updateElement('total-proxies', data.stats.total || 0);
            updateElement('active-proxies', data.stats.active || 0);
        }

    } catch (error) {
        console.error('❌ Error handling proxy update status:', error);
    }
}

// Connection status
function updateConnectionStatus(status, message) {
    const statusElement = document.getElementById('connection-status');
    if (statusElement) {
        const statusClass = status === 'connected' ? 'text-success' : 'text-danger';
        statusElement.innerHTML = `<i class="fas fa-circle ${statusClass}"></i> ${message}`;
    }
}


// Initialize charts (placeholder)
function initializeCharts() {
    console.log('📈 Initializing charts...');
    // TODO: Add chart initialization if needed
}

// document.addEventListener('DOMContentLoaded', initializeUpload);

// Show notification
function showNotification(message, type = 'info') {
    console.log(`📢 ${type.toUpperCase()}: ${message}`);
    const container = document.getElementById('notification-container');
    const div = document.createElement('div');
    div.className = `notification ${type}`;
    div.textContent = message;
    container.appendChild(div);
    setTimeout(() => div.remove(), 4000);
}

// Hide loading overlay when page is ready
window.addEventListener('load', function () {
    console.log('🎯 Page fully loaded, hiding loading overlay...');
    hideLoadingOverlay();
});

// Hide loading overlay function
function hideLoadingOverlay() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
}

// همچنین در handleConnect اضافه کنید:
function handleConnect() {
    console.log('✅ Connected to server');
    updateConnectionStatus('connected', 'متصل به سرور');

    // Hide loading overlay
    hideLoadingOverlay();

    // Request initial stats
    setTimeout(() => {
        console.log('📊 Requesting initial stats...');
        socket.emit('request-stats');
    }, 100);
}

// برای اطمینان، در انتهای initializeDashboard هم اضافه کنید:
function initializeDashboard() {
    console.log('🚀 Dashboard initializing...');
    initializeSocket();
    initializeEventListeners();
    initializeCharts();

    statsUpdateInterval = setInterval(() => {
        if (socket && socket.connected) {
            console.log('📊 Periodic stats request...');
            socket.emit('request-stats');
        }
    }, 5000);

    // مخفی کردن لودینگ بعد از آماده شدن
    setTimeout(hideLoadingOverlay, 1000);
    console.log('✅ Dashboard initialized');
}

// تابع تست در Console
window.testStats = function () {
    console.log('🧪 Testing stats update...');
    fetchStatsViaAPI();
};

window.debugSocket = function () {
    console.log('🔍 Socket debug info:');
    console.log('Connected:', socket?.connected);
    console.log('ID:', socket?.id);
    console.log('Transport:', socket?.io?.engine?.transport?.name);
    return socket;
};