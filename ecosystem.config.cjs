module.exports = {
  apps: [
    {
      name: 'sage',
      // 防休眠命令
      script: 'caffeinate',
      args: '-i bun --env-file .env src/index.ts',
      cwd: __dirname,
      env: {
        CLAUDE_CODE_WORK_DIR: __dirname + '/agent_home',
        CODEX_WORK_DIR: __dirname + '/agent_home',
      },
      restart_delay: 3000,
      max_restarts: 10,
      out_file: 'logs/sage.log',
      error_file: 'logs/sage-error.log',
      time: true
    },
    {
      name: 'sage-dev',
      script: 'caffeinate',
      args: '-i bun --env-file .env.dev src/index.ts',
      cwd: __dirname,
      env: {
        CLAUDE_CODE_WORK_DIR: __dirname + '/agent_home',
        CODEX_WORK_DIR: __dirname + '/agent_home',
      },
      restart_delay: 3000,
      max_restarts: 10,
      out_file: 'logs/sage-dev.log',
      error_file: 'logs/sage-dev-error.log',
      time: true
    }
  ]
}
