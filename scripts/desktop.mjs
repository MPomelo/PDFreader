import { existsSync, readFileSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
const mode = process.argv[2];
if (!['dev', 'build', 'bundle', 'test'].includes(mode)) throw Error('Use dev, build, bundle or test');
const env = { ...process.env };
if (existsSync(resolve('.local/cargo/bin/cargo.exe'))) {
  env.CARGO_HOME = resolve('.local/cargo');
  env.RUSTUP_HOME = resolve('.local/rustup');
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = resolve('.local/cargo/bin') + delimiter + (env[pathKey] || '');
}
const pkg = JSON.parse(readFileSync('node_modules/@tauri-apps/cli/package.json', 'utf8'));
const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tauri;
const result = mode === 'test'
  ? spawnSync(existsSync(resolve('.local/cargo/bin/cargo.exe')) ? resolve('.local/cargo/bin/cargo.exe') : 'cargo', ['test', '--release', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', ...process.argv.slice(3)], { env, stdio: 'inherit' })
  : spawnSync(process.execPath, [resolve('node_modules/@tauri-apps/cli', bin), mode === 'bundle' ? 'build' : mode, ...(mode === 'build' ? ['--no-bundle', '--', '--locked'] : mode === 'bundle' ? ['--bundles', 'nsis', '--', '--locked'] : [])], { env, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
