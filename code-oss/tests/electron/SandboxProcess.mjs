import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hasErrorCode } from '#scripts/support/hasErrorCode.mjs';

/** Resolve only a process inside this fixture application's descendant tree.
 * Linux sandbox PIDs are namespace-local and must never be signalled as host PIDs.
 * @param {number | undefined} applicationPid
 * @param {number} sandboxPid
 */
export async function hostProcessId(applicationPid, sandboxPid) {
  if (applicationPid === undefined || applicationPid <= 1 || !Number.isSafeInteger(sandboxPid) || sandboxPid <= 1)
    throw new Error('Expected a running fixture application and sandbox process.');
  if (process.platform !== 'linux') return sandboxPid;
  const processes = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map(line => line.trim().split(/\s+/u).map(Number));
  const descendants = new Set([applicationPid]);
  for (let previous = 0; previous !== descendants.size;) {
    previous = descendants.size;
    for (const [pid, parent] of processes) if (descendants.has(parent)) descendants.add(pid);
  }
  const matches = [];
  for (const pid of descendants) {
    if (pid === applicationPid) continue;
    let status;
    try {
      status = await readFile(`/proc/${pid}/status`, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) continue;
      throw error;
    }
    const ids = /^NSpid:\s*(.+)$/mu.exec(status)?.[1].trim().split(/\s+/u).map(Number);
    if (ids !== undefined && ids.length > 1 && ids.at(-1) === sandboxPid) matches.push(pid);
  }
  if (matches.length !== 1)
    throw new Error(`Expected one fixture process for sandbox PID ${sandboxPid}, found ${matches.length}.`);
  return matches[0];
}

/** Only ESRCH proves exit; permission errors must never count as success.
 * @param {number} pid
 */
export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return false;
    throw error;
  }
}
