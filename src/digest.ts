import { createHash } from 'node:crypto'
import { opendir, readFile, readlink } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export async function hashTree(
  root: string,
  allowSymlinks = false,
  prune?: (relativePath: string) => boolean,
): Promise<string> {
  const hash = createHash('sha256')
  const directories = [root]
  const files: string[] = []
  const links: string[] = []

  while (directories.length > 0) {
    const directory = directories.pop()
    if (!directory) break
    const entries = []
    for await (const entry of await opendir(directory)) entries.push(entry)
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      if (entry.name === '.git') continue
      const path = resolve(directory, entry.name)
      if (prune?.(relative(root, path))) continue
      if (entry.isSymbolicLink()) {
        if (!allowSymlinks) throw new Error('candidate artifact must not contain symbolic links')
        links.push(path)
      } else if (entry.isDirectory()) directories.push(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error('candidate artifact must contain only files and directories')
    }
  }

  for (const path of links.sort()) {
    const name = relative(root, path)
    const target = await readlink(path)
    hash.update(`link:${Buffer.byteLength(name)}:${name}:${Buffer.byteLength(target)}:${target}`)
  }

  for (const path of files.sort()) {
    const name = relative(root, path)
    const content = await readFile(path)
    hash.update(`${Buffer.byteLength(name)}:${name}:${content.length}:`)
    hash.update(content)
  }
  return `sha256:${hash.digest('hex')}`
}
