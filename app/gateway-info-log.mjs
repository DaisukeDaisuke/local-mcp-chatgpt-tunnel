import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const pad = (value, width = 2) => String(value).padStart(width, '0');

export function gatewayLogFileName(startedAt = new Date(), pid = process.pid) {
  return [
    startedAt.getFullYear(),
    pad(startedAt.getMonth() + 1),
    pad(startedAt.getDate())
  ].join('-')
    + '_'
    + [
      pad(startedAt.getHours()),
      pad(startedAt.getMinutes()),
      pad(startedAt.getSeconds()),
      pad(startedAt.getMilliseconds(), 3)
    ].join('-')
    + `_pid-${pid}.txt`;
}

export function createGatewayInfoLogger({
  enabled = false,
  directory,
  stderr = process.stderr,
  startedAt = new Date(),
  pid = process.pid
}) {
  if (typeof enabled !== 'boolean') throw new Error('Gateway file logging enabled flag must be boolean');
  if (enabled && (typeof directory !== 'string' || directory.length === 0)) {
    throw new Error('Gateway file logging requires a log directory');
  }
  const filePath = enabled ? join(directory, gatewayLogFileName(startedAt, pid)) : null;
  if (filePath) mkdirSync(directory, { recursive: true });

  return {
    filePath,
    info(message) {
      const line = `[gateway] INFO ${message}\n`;
      stderr.write(line);
      if (filePath) appendFileSync(filePath, line, 'utf8');
    }
  };
}
