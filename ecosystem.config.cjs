module.exports = {
  apps: [
    {
      name: 'sage',
      script: 'bun',
      args: '--env-file .env src/index.ts',
      cwd: __dirname,
      restart_delay: 3000,
      max_restarts: 10,
      out_file: 'logs/sage.log',
      error_file: 'logs/sage-error.log',
      time: true
    },
    {
      name: 'sage-dev',
      script: 'bun',
      args: '--env-file .env.dev src/index.ts',
      cwd: __dirname,
      restart_delay: 3000,
      max_restarts: 10,
      out_file: 'logs/sage-dev.log',
      error_file: 'logs/sage-dev-error.log',
      time: true
    }
  ]
}
