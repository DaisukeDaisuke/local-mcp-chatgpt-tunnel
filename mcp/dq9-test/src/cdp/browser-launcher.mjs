import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RelayError } from '../util/errors.mjs';

export class BrowserLauncher {
  constructor({ spawnImpl = spawn, mkdirImpl = mkdir } = {}) {
    this.spawnImpl = spawnImpl;
    this.mkdirImpl = mkdirImpl;
    this.activePorts = new Set();
    this.activeProfiles = new Set();
  }

  async launch(config) {
    const cdpPort = Number(config.cdpPort);
    if (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535) {
      throw new RelayError('CHROME_LAUNCH_INVALID', 'cdpPort must be an integer between 1024 and 65535');
    }
    const profileDirectory = resolve(config.profileDirectory ?? join(config.runtimeDirectory, 'chrome-profile'));
    this.#reserve(cdpPort, profileDirectory);
    const args = [
      '--headless=new',
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDirectory}`,
      '--window-size=1280,720',
      '--no-first-run',
      '--no-default-browser-check',
      config.url
    ];
    let child;
    try {
      await this.mkdirImpl(profileDirectory, { recursive: true });
      child = this.spawnImpl(config.chromePath, args, { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      this.#release(cdpPort, profileDirectory);
      throw new RelayError('CHROME_LAUNCH_FAILED', error.message);
    }
    if (!child?.pid) {
      this.#release(cdpPort, profileDirectory);
      throw new RelayError('CHROME_LAUNCH_FAILED', 'Chrome did not return an owned process handle');
    }
    const release = () => this.#release(cdpPort, profileDirectory);
    child.once?.('exit', release);
    child.once?.('error', release);
    return { child, profileDirectory, cdpPort, release };
  }

  async stop(ownedBrowser) {
    if (!ownedBrowser?.child || ownedBrowser.child.exitCode !== null || ownedBrowser.child.killed) return { stopped: false, reason: 'already-stopped' };
    try {
      ownedBrowser.child.kill();
      return { stopped: true, pid: ownedBrowser.child.pid };
    } catch (error) {
      throw new RelayError('CHROME_STOP_FAILED', error.message, { pid: ownedBrowser.child.pid });
    }
  }

  #reserve(cdpPort, profileDirectory) {
    if (this.activePorts.has(cdpPort)) {
      throw new RelayError('CHROME_LAUNCH_COLLISION', 'A live launcher already owns this CDP port', { cdpPort });
    }
    if (this.activeProfiles.has(profileDirectory)) {
      throw new RelayError('CHROME_LAUNCH_COLLISION', 'A live launcher already owns this Chrome profile directory', { profileDirectory });
    }
    this.activePorts.add(cdpPort);
    this.activeProfiles.add(profileDirectory);
  }

  #release(cdpPort, profileDirectory) {
    this.activePorts.delete(cdpPort);
    this.activeProfiles.delete(profileDirectory);
  }
}
