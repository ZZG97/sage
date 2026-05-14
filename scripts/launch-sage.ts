import { basename, resolve } from 'node:path';
import { parse } from 'dotenv';

type EnvMap = Record<string, string>;

interface LaunchOptions {
  envFile: string;
  instance: 'sage' | 'sage-dev';
  command: string[];
}

const INHERITED_ENV_ALLOWLIST = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
];

const DEFAULT_PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  `${process.env.HOME ?? ''}/.bun/bin`,
  `${process.env.HOME ?? ''}/.nvm/versions/node/v24.14.0/bin`,
].filter(Boolean).join(':');

function usage(): never {
  console.error(
    'Usage: bun scripts/launch-sage.ts --env-file <file> --instance <sage|sage-dev> -- <command...>'
  );
  process.exit(2);
}

function parseArgs(argv: string[]): LaunchOptions {
  let envFile: string | undefined;
  let instance: LaunchOptions['instance'] | undefined;

  const separatorIndex = argv.indexOf('--');
  if (separatorIndex === -1) usage();

  const optionArgs = argv.slice(0, separatorIndex);
  const command = argv.slice(separatorIndex + 1);
  if (command.length === 0) usage();

  for (let i = 0; i < optionArgs.length; i += 1) {
    const arg = optionArgs[i];
    if (arg === '--env-file') {
      envFile = optionArgs[++i];
    } else if (arg === '--instance') {
      const value = optionArgs[++i];
      if (value !== 'sage' && value !== 'sage-dev') {
        throw new Error(`Invalid --instance: ${value}`);
      }
      instance = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!envFile || !instance) usage();
  return { envFile, instance, command };
}

function pickInheritedEnv(): EnvMap {
  const env: EnvMap = {};
  for (const key of INHERITED_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH = env.PATH || DEFAULT_PATH;
  env.LANG = env.LANG || 'C.UTF-8';
  env.TMPDIR = env.TMPDIR || '/tmp';
  return env;
}

async function readEnvFile(path: string): Promise<EnvMap> {
  const absolutePath = resolve(process.cwd(), path);
  const text = await Bun.file(absolutePath).text();
  return expandHomeValues(parse(text));
}

function assertEqual(env: EnvMap, key: string, expected: string, instance: string): void {
  if (env[key] !== expected) {
    throw new Error(`${instance} requires ${key}=${expected}, got ${env[key] ?? '<unset>'}`);
  }
}

async function validateEnv(env: EnvMap, options: LaunchOptions): Promise<void> {
  const envFileName = basename(options.envFile);

  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error(`${options.instance} requires FEISHU_APP_ID and FEISHU_APP_SECRET`);
  }

  if (options.instance === 'sage-dev') {
    if (envFileName !== '.env.dev') {
      throw new Error('sage-dev must launch from .env.dev');
    }
    assertEqual(env, 'NODE_ENV', 'development', options.instance);
    assertEqual(env, 'PORT', '3001', options.instance);

    const prodEnv = await readOptionalEnvFile('.env');
    const prodAppId = prodEnv?.FEISHU_APP_ID;
    if (prodAppId && env.FEISHU_APP_ID === prodAppId) {
      throw new Error('sage-dev FEISHU_APP_ID matches prod .env; refusing to start');
    }
    return;
  }

  if (envFileName !== '.env') {
    throw new Error('sage must launch from .env');
  }
  assertEqual(env, 'NODE_ENV', 'production', options.instance);
  assertEqual(env, 'PORT', '3000', options.instance);

  const devEnv = await readOptionalEnvFile('.env.dev');
  const devAppId = devEnv?.FEISHU_APP_ID;
  if (devAppId && env.FEISHU_APP_ID === devAppId) {
    throw new Error('sage FEISHU_APP_ID matches dev .env.dev; refusing to start');
  }
}

async function readOptionalEnvFile(path: string): Promise<EnvMap | null> {
  const file = Bun.file(resolve(process.cwd(), path));
  if (!(await file.exists())) return null;
  return expandHomeValues(parse(await file.text()));
}

function expandHomeValues(env: EnvMap): EnvMap {
  const home = process.env.HOME;
  if (!home) return env;

  const expanded: EnvMap = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === '~') {
      expanded[key] = home;
    } else if (value.startsWith('~/')) {
      expanded[key] = `${home}/${value.slice(2)}`;
    } else {
      expanded[key] = value;
    }
  }
  return expanded;
}

function forwardSignal(child: Bun.Subprocess, signal: NodeJS.Signals): void {
  process.on(signal, () => {
    child.kill(signal);
  });
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const fileEnv = await readEnvFile(options.envFile);
  const env: EnvMap = {
    ...pickInheritedEnv(),
    ...fileEnv,
    SAGE_INSTANCE: options.instance,
    PROCESS_NAME: options.instance,
  };

  await validateEnv(env, options);

  const child = Bun.spawn(options.command, {
    cwd: process.cwd(),
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  forwardSignal(child, 'SIGINT');
  forwardSignal(child, 'SIGTERM');

  const exitCode = await child.exited;
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
