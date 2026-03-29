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
      kill_timeout: 35000, // 给 drain 30s + 5s 余量
      out_file: 'logs/sage.log',
      error_file: 'logs/sage-error.log',
      time: true
    },
    {
      name: 'sage-dev',
      script: 'caffeinate',
      args: '-i bun --no-env-file --env-file .env.dev src/index.ts',
      cwd: __dirname,
      env: {
        CLAUDE_CODE_WORK_DIR: __dirname + '/agent_home',
        CODEX_WORK_DIR: __dirname + '/agent_home',
      },
      restart_delay: 3000,
      max_restarts: 10,
      kill_timeout: 35000,
      out_file: 'logs/sage-dev.log',
      error_file: 'logs/sage-dev-error.log',
      time: true
    }
  ]
}
