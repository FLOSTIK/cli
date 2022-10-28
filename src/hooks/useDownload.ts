import { readerFromStreamReader, copy } from "deno/streams/conversion.ts"
import { Logger, teal } from "./useLogger.ts"
import { useFlags, usePrefix } from "hooks"
import { chuzzle, panic } from "utils"
import { Sha256 } from "deno/hash/sha256.ts"
import Path from "path"
import { gray } from "https://deno.land/std@0.158.0/fmt/colors.ts"

interface DownloadOptions {
  src: URL
  dst?: Path  /// default is our own unique cache path
  headers?: Record<string, string>
  ephemeral?: boolean  /// always download, do not rely on cache
  logger?: Logger
}

interface RV {
  path: Path

  // we only give you the sha if we download
  // if we found the cache then you have to calculate the sha yourself
  sha: string | undefined
}

async function internal<T>({ src, dst, headers, ephemeral, logger }: DownloadOptions,
  body: (src: ReadableStream<Uint8Array>, dst: Deno.Writer, sz?: number) => Promise<T>): Promise<Path>
{
  logger ??= new Logger()

  console.verbose({src: src, dst})

  const hash = (() => {
    let memo: Path
    return () => memo ?? (memo = hash_key(src))
  })()
  const mtime_entry = () => hash().join("mtime")

  const { numpty } = useFlags()
  dst ??= hash().join(src.path().basename())
  if (src.protocol === "file:") throw new Error()

  if (!ephemeral && mtime_entry().isFile() && dst.isReadableFile()) {
    headers ??= {}
    headers["If-Modified-Since"] = await mtime_entry().read()
    logger.replace(teal('querying'))
  } else {
    logger.replace(teal('downloading'))
  }

  // so the user can add private repos if they need to etc.
  if (/(^|\.)github.com$/.test(src.host)) {
    const token = Deno.env.get("GITHUB_TOKEN")
    if (token) {
      headers ??= {}
      headers["Authorization"] = `bearer ${token}`
    }
  }

  const rsp = await fetch(src, {headers})

  switch (rsp.status) {
  case 200: {
    const sz = chuzzle(parseInt(rsp.headers.get("Content-Length")!))

    let txt = teal('downloading')
    if (sz) txt += ` ${gray(pretty_size(sz))}`
    logger.replace(txt)

    const reader = rsp.body ?? panic()
    const f = await Deno.open(dst.string, {create: true, write: true, truncate: true})
    try {
      dst.parent().mkpath()
      await body(reader, f, sz)

      //TODO etags too
      const text = rsp.headers.get("Last-Modified")
      if (text) mtime_entry().write({ text, force: true })

    } finally {
      f.close()
    }
  } break
  case 304:
    logger.replace(`cache: ${teal('hit')}`)
    break
  default:
    if (!numpty || !dst.isFile()) {
      throw new Error(`${rsp.status}: ${src}`)
    }
  }

  return dst
}

async function download(opts: DownloadOptions): Promise<Path> {
  return await internal(opts, (src, dst) => copy(readerFromStreamReader(src.getReader()), dst))
}

async function download_with_sha(opts: DownloadOptions): Promise<{path: Path, sha: string}> {
  opts.logger ??= new Logger()

  const digest = new Sha256()
  let run = false

  // don’t fill CI logs with dozens of download percentage lines
  const ci = Deno.env.get("CI")

  const path = await internal(opts, (src, dst, sz) => {
    let n = 0

    run = true
    const tee = src.tee()
    const p1 = copy(readerFromStreamReader(tee[0].getReader()), dst)
    const p2 = copy(readerFromStreamReader(tee[1].getReader()), { write: buf => {
      //TODO in separate thread would be likely be faster
      digest.update(buf)
      if (sz && !ci) {
        n += buf.length
        const pc = Math.round(n / sz * 100)
        opts.logger!.replace(`${teal('downloading')} ${pc}%`)
      }
      return Promise.resolve(buf.length)
    }})
    return Promise.all([p1, p2])
  })

  if (!run) {
    opts.logger.replace(teal('verifying'))
    const f = await Deno.open(path.string, { read: true })
    await copy(f, { write: buf => {
      //TODO in separate thread would likely be faster
      digest.update(buf)
      return Promise.resolve(buf.length)
    }})
  }

  return { path, sha: digest.hex() }
}

function hash_key(url: URL): Path {
  function hash(url: URL) {
    const formatted = `${url.pathname}${url.search ? "?" + url.search : ""}`
    return new Sha256().update(formatted).toString()
  }

  const prefix = usePrefix().www

  return prefix
    .join(url.protocol.slice(0, -1))
    .join(url.hostname)
    .join(hash(url))
    .mkpath()
}

export default function useDownload() {
  return { download, hash_key, download_with_sha }
}

function pretty_size(n: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let i = 0
  while (n > 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  const precision = n < 10 ? 2 : n < 100 ? 1 : 0
  return `${n.toFixed(precision)} ${units[i]}`
}
