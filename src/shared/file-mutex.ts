/**
 * Per-path async mutex for serializing read-modify-write operations.
 * All hooks and tools run in the same Bun process, so in-memory locking suffices.
 */

const locks = new Map<string, Promise<void>>()

export async function withFileLock<T>(
  filePath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const key = filePath.replace(/\\/g, "/")

  while (locks.has(key)) {
    await locks.get(key)
  }

  let unlock: () => void
  const lockPromise = new Promise<void>((resolve) => {
    unlock = resolve
  })
  locks.set(key, lockPromise)

  try {
    return await fn()
  } finally {
    locks.delete(key)
    unlock!()
  }
}
