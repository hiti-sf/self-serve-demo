#!/usr/bin/env node
/**
 * Compile the kiosk launcher (SPEC §8.2).
 *
 * Binaries are not committed: they are ~7 MB each and rebuilding them is a `go build`.
 * `build:kiosk` compiles for the host platform automatically; pass `--all-platforms` to
 * produce the set a sales engineer might need (Windows x64, macOS arm64/x64, Linux x64).
 *
 * If Go is unavailable the kiosk build still succeeds — the bundle falls back to the
 * `launch.*` scripts, which use Node or `npx serve`. The Go binary is the preferred path
 * because it is the only one that needs nothing installed on the machine.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const launcherDir = resolve(import.meta.dirname);
const binDir = join(launcherDir, 'bin');

const TARGETS = [
  { goos: 'windows', goarch: 'amd64', out: 'demo-kiosk-windows-x64.exe' },
  { goos: 'darwin', goarch: 'arm64', out: 'demo-kiosk-macos-arm64' },
  { goos: 'darwin', goarch: 'amd64', out: 'demo-kiosk-macos-x64' },
  { goos: 'linux', goarch: 'amd64', out: 'demo-kiosk-linux-x64' },
];

const HOST_MAP = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const ARCH_MAP = { x64: 'amd64', arm64: 'arm64' };

export async function hasGo() {
  try {
    await execFileAsync('go', ['version']);
    return true;
  } catch {
    return false;
  }
}

export function hostTarget() {
  const goos = HOST_MAP[process.platform];
  const goarch = ARCH_MAP[process.arch];
  return TARGETS.find((target) => target.goos === goos && target.goarch === goarch) ?? null;
}

export async function buildLauncher({ all = false, quiet = false } = {}) {
  if (!(await hasGo())) {
    if (!quiet) {
      console.warn(
        'Go is not installed, so no launcher binary was built.\n' +
          'The bundle still ships launch.cmd / launch.command / launch.sh, which fall back to Node.',
      );
    }
    return [];
  }

  await mkdir(binDir, { recursive: true });
  const targets = all ? TARGETS : [hostTarget()].filter(Boolean);
  const built = [];

  for (const target of targets) {
    const output = join(binDir, target.out);
    await execFileAsync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', output, '.'], {
      cwd: launcherDir,
      env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' },
    });
    if (target.goos !== 'windows') await chmod(output, 0o755);
    const { size } = await stat(output);
    built.push({ ...target, path: output, size });
    if (!quiet) console.log(`  launcher ${target.goos}/${target.goarch} → ${target.out} (${Math.round(size / 1024 / 1024)} MB)`);
  }

  return built;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const built = await buildLauncher({ all: process.argv.includes('--all-platforms') });
  console.log(`\n${built.length} launcher binary/binaries in ${binDir}`);
}
