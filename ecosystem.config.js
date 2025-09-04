module.exports = {
    apps: [
        {
            // Main Server
            name: 'sony-server',
            script: './src/app.js',
            cwd: './',
            instances: 1,
            exec_mode: 'fork', // تغییر از cluster به fork برای تک instance
            watch: false,
            max_memory_restart: '1G',
            node_args: '--max-old-space-size=1024',
            env: {
                NODE_ENV: 'production',
                PORT: 3000
            },
            env_development: {
                NODE_ENV: 'development',
                PORT: 3000
            },
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            error_file: './logs/server-error.log',
            out_file: './logs/server-out.log',
            log_file: './logs/server-combined.log',
            pid_file: './logs/server.pid',
            time: true,
            autorestart: true,
            restart_delay: 5000,
            max_restarts: 10,
            min_uptime: '10s',
            kill_timeout: 5000,
            listen_timeout: 3000,

            // اضافه کردن ignore patterns
            ignore_watch: [
                'node_modules',
                'logs',
                'uploads',
                '.git',
                '*.log'
            ],

            // اضافه کردن merge logs
            merge_logs: true,

            // اضافه کردن source map support
            source_map_support: true
        }
    ]
};