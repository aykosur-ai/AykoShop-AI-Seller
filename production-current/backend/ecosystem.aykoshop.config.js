module.exports = {
  apps: [{
    name: 'aykoshop-api',
    script: '/var/www/backend/server.js',
    cwd: '/root',
    exec_mode: 'fork',
    instances: 1,
    interpreter: 'node',
    autorestart: true,
    watch: false,
    max_restarts: 15,
    min_uptime: '20s',
    restart_delay: 4000,
    max_memory_restart: '600M'
  }]
};
