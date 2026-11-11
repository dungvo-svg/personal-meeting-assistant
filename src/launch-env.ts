// The Windows WMI launcher does not inherit its caller's environment. Keep the
// sender and host on one allowlist, including capture choices made before start.
export const DAEMON_ENV = ['PMA_PORT', 'PMA_DATA_DIR', 'PMA_TEST_MODE', 'PMA_IDLE_MINUTES', 'PMA_PYTHON', 'PMA_EXIT_AFTER_FINISH', 'PMA_MIC', 'PMA_AUTO_SOURCE'];

export function daemonEnvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return DAEMON_ENV.filter(key => env[key] !== undefined).flatMap(key => ['--env', `${key}=${env[key]}`]);
}

export function applyDaemonEnv(argv: string[], env: NodeJS.ProcessEnv = process.env): void {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== '--env') continue;
    const [key, ...value] = argv[++i].split('=');
    if (DAEMON_ENV.includes(key)) env[key] = value.join('=');
  }
}
