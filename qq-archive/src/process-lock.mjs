import fs from 'node:fs/promises';
import path from 'node:path';

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function acquireProcessLock(archiveRoot) {
  await fs.mkdir(archiveRoot, { recursive: true });
  const lockPath = path.join(archiveRoot, '.qq-archive.lock');
  const owner = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    cwd: process.cwd()
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.close();
      let released = false;
      return {
        lockPath,
        async release() {
          if (released) return;
          released = true;
          const current = await readLock(lockPath);
          if (current?.pid === process.pid) {
            await fs.unlink(lockPath).catch(() => undefined);
          }
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await readLock(lockPath);
      if (current && isProcessAlive(current.pid)) {
        throw new Error(`QQ 归档器已在运行（PID ${current.pid}）`);
      }
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
  throw new Error('无法获取 QQ 归档器进程锁');
}
