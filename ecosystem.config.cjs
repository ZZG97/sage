module.exports = {
  apps: [{
    name: 'sage',
    script: 'bun',
    args: 'run start',
    cwd: __dirname,
    env_file: '.env',
    restart_delay: 3000,
    max_restarts: 10,
    out_file: 'logs/sage.log',
    error_file: 'logs/sage-error.log',
    time: true
  }]
}
