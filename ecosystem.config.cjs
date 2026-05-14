module.exports = {
  apps: [
    {
      name: 'sage',
      script: 'bun',
      args: [
        'scripts/launch-sage.ts',
        '--env-file',
        '.env',
        '--instance',
        'sage',
        '--',
        'caffeinate',
        '-i',
        'bun',
        'src/index.ts'
      ],
      cwd: __dirname,
      env: {},
      restart_delay: 3000,
      max_restarts: 10,
      kill_timeout: 35000, // 给 drain 30s + 5s 余量
      out_file: 'logs/sage.log',
      error_file: 'logs/sage-error.log',
      time: true
    },
    {
      name: 'sage-dev',
      script: 'bun',
      args: [
        'scripts/launch-sage.ts',
        '--env-file',
        '.env.dev',
        '--instance',
        'sage-dev',
        '--',
        'caffeinate',
        '-i',
        'bun',
        'src/index.ts'
      ],
      cwd: __dirname,
      env: {},
      restart_delay: 3000,
      max_restarts: 10,
      kill_timeout: 35000,
      out_file: 'logs/sage-dev.log',
      error_file: 'logs/sage-dev-error.log',
      time: true
    }
  ]
}
