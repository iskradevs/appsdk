import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  opendir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Readable, Writable } from "node:stream";

import { ZipFile } from "yazl";

const fixedZipTime = new Date(2000, 0, 1, 0, 0, 0, 0);
const sourceRoots = ["app.json", "src", "static"] as const;

export const SOURCE_MAX_FILES = 2_000;
export const SOURCE_MAX_DIRECTORIES = 2_000;
export const SOURCE_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const SOURCE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const SOURCE_MAX_INSPECTED_ENTRIES = SOURCE_MAX_FILES + SOURCE_MAX_DIRECTORIES;
const SOURCE_READ_CHUNK_BYTES = 64 * 1024;

interface CollectedSourceEntry {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly name: string;
  readonly size: bigint;
}

interface SourceEntry extends CollectedSourceEntry {
  readonly digest: string;
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly path: string;
}

interface TemporaryLocation {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly path: string;
  readonly size: bigint;
}

interface CollectState {
  readonly files: CollectedSourceEntry[];
  directories: number;
  inspectedEntries: number;
}

export interface PackSourceArchiveOptions {
  /**
   * Requires Linux `/proc/self/fd` path recovery. Defaults to true on Linux
   * and false on other platforms.
   */
  readonly requireStableDescriptors?: boolean;
}

/**
 * Packs authoring sources while the caller keeps the canonical output parent
 * at the same pathname for the full returned Promise. Moving or replacing that
 * parent mid-operation is unsupported. The authoring runtime satisfies this
 * contract with its fixed writable `/workspace` mount. Source file changes
 * during packing are still detected and rejected.
 */
export async function packSourceArchive(
  projectDir: string,
  outputPath: string,
  options: PackSourceArchiveOptions = {},
): Promise<string> {
  const requireStableDescriptors =
    options.requireStableDescriptors ?? (process.platform === "linux");
  const root = await realpath(resolve(projectDir));
  const requestedOutput = resolve(outputPath);
  const requestedOutputParent = dirname(requestedOutput);
  const outputParent = await realpath(requestedOutputParent);
  const outputParentInfo = await stat(outputParent, { bigint: true });
  if (!outputParentInfo.isDirectory()) {
    throw new Error("source archive output parent must be a directory");
  }
  const outputParentIdentity: DirectoryIdentity = {
    dev: outputParentInfo.dev,
    ino: outputParentInfo.ino,
    path: outputParent,
  };
  const output = join(outputParent, basename(requestedOutput));
  if (isWithin(root, output)) {
    throw new Error("source archive output must be outside project root");
  }

  const state: CollectState = {
    files: [],
    directories: 0,
    inspectedEntries: 0,
  };
  for (const sourceRoot of sourceRoots) {
    await collect(root, sourceRoot, state, sourceRoot === "static");
  }
  state.files.sort((left, right) => compareSourceNames(left.name, right.name));
  enforceLimits(state.files);
  const files = await snapshotSourceEntries(root, state.files);

  if (requireStableDescriptors) {
    await assertStableDescriptorRuntime(outputParent);
  }
  const temporary = `${output}.tmp-${process.pid}-${randomUUID()}`;
  await assertOutputParentUnchanged(
    requestedOutputParent,
    outputParentIdentity,
  );

  const temporaryHandle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let handleClosed = false;
  let location: TemporaryLocation | undefined;
  try {
    await writeZip(root, files, temporaryHandle);
    location = await locateTemporary(
      temporaryHandle,
      temporary,
      requireStableDescriptors,
    );
    await temporaryHandle.close();
    handleClosed = true;
    await assertTemporaryUnchanged(location);
    await assertOutputParentUnchanged(
      requestedOutputParent,
      outputParentIdentity,
    );
    await rename(location.path, output);
    return output;
  } catch (error) {
    const failures: unknown[] = [error];
    if (location === undefined && !handleClosed) {
      try {
        location = await locateTemporary(
          temporaryHandle,
          temporary,
          requireStableDescriptors,
        );
      } catch (locationError) {
        failures.push(locationError);
      }
    }
    if (!handleClosed) {
      try {
        await temporaryHandle.close();
        handleClosed = true;
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    if (location === undefined) {
      failures.push(
        new Error(
          "source archive temporary was not removed because its stable descriptor path is unavailable",
        ),
      );
    } else {
      try {
        await assertTemporaryUnchanged(location);
        await rm(location.path, { force: true });
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    throw combineFailures(
      failures,
      "source archive failed during temporary lifecycle",
    );
  }
}

export function compareSourceNames(left: string, right: string): number {
  const localized = left.localeCompare(right, "en");
  if (localized !== 0) return localized;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function collect(
  root: string,
  name: string,
  state: CollectState,
  optional: boolean,
): Promise<void> {
  assertSafeSourcePath(name);
  if (forbiddenSourcePath(name)) return;
  const path = join(root, name);
  let info;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    if (optional && isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`symlink is forbidden in source archive: ${name}`);
  }
  const actual = await realpath(path);
  if (!isWithin(root, actual)) {
    throw new Error(`source path escapes project root: ${name}`);
  }
  if (info.isFile()) {
    state.files.push({
      ctimeNs: info.ctimeNs,
      dev: info.dev,
      ino: info.ino,
      mtimeNs: info.mtimeNs,
      name,
      size: info.size,
    });
    if (state.files.length > SOURCE_MAX_FILES) {
      throw new Error("source file count limit exceeded");
    }
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(`unsupported source entry: ${name}`);
  }

  state.directories += 1;
  if (state.directories > SOURCE_MAX_DIRECTORIES) {
    throw new Error("source directory count limit exceeded");
  }
  const children: string[] = [];
  const directory = await opendir(path);
  try {
    while (true) {
      const child = await directory.read();
      if (child === null) break;
      state.inspectedEntries += 1;
      if (state.inspectedEntries > SOURCE_MAX_INSPECTED_ENTRIES) {
        throw new Error("source inspected entry limit exceeded");
      }
      children.push(child.name);
    }
  } finally {
    await directory.close();
  }
  children.sort(compareSourceNames);
  for (const child of children) {
    await collect(root, join(name, child), state, false);
  }
}

function assertSafeSourcePath(name: string): void {
  if (name.split(sep).some((segment) => segment.includes("\\"))) {
    throw new Error(`backslash is forbidden in source archive path: ${name}`);
  }
}

function forbiddenSourcePath(name: string): boolean {
  return name
    .split(sep)
    .some(
      (segment) =>
        segment === "node_modules" ||
        segment === ".iskra-build" ||
        segment.startsWith(".env"),
    );
}

function enforceLimits(files: readonly CollectedSourceEntry[]): void {
  if (files.length > SOURCE_MAX_FILES) {
    throw new Error("source file count limit exceeded");
  }
  let total = 0n;
  for (const file of files) {
    if (file.size > BigInt(SOURCE_MAX_ENTRY_BYTES)) {
      throw new Error(`source entry size limit exceeded: ${file.name}`);
    }
    total += file.size;
    if (total > BigInt(SOURCE_MAX_TOTAL_BYTES)) {
      throw new Error("source total size limit exceeded");
    }
  }
}

async function snapshotSourceEntries(
  root: string,
  entries: readonly CollectedSourceEntry[],
): Promise<SourceEntry[]> {
  const snapshots: SourceEntry[] = [];
  for (const entry of entries) {
    snapshots.push({ ...entry, digest: await digestSourceEntry(root, entry) });
  }
  return snapshots;
}

async function digestSourceEntry(
  root: string,
  entry: CollectedSourceEntry,
): Promise<string> {
  const path = join(root, entry.name);
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertSourceEntryUnchanged(
      await handle.stat({ bigint: true }),
      entry,
      `source entry changed: ${entry.name}`,
    );
    const digest = createHash("sha256");
    const size = Number(entry.size);
    let position = 0;
    while (position < size) {
      const length = Math.min(SOURCE_READ_CHUNK_BYTES, size - position);
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, position);
      if (result.bytesRead === 0) {
        throw new Error(`source entry changed during read: ${entry.name}`);
      }
      position += result.bytesRead;
      digest.update(buffer.subarray(0, result.bytesRead));
    }
    const probe = Buffer.allocUnsafe(1);
    if ((await handle.read(probe, 0, 1, position)).bytesRead !== 0) {
      throw new Error(`source entry changed during read: ${entry.name}`);
    }
    assertSourceEntryUnchanged(
      await handle.stat({ bigint: true }),
      entry,
      `source entry changed during read: ${entry.name}`,
    );
    return digest.digest("hex");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (closeError) {
        if (failure !== undefined) {
          throw new AggregateError(
            [failure, closeError],
            `source entry changed and could not be closed: ${entry.name}`,
          );
        }
        throw closeError;
      }
    }
  }
}

function assertSourceEntryUnchanged(
  info: BigIntStats,
  entry: CollectedSourceEntry,
  message: string,
): void {
  if (
    !info.isFile() ||
    info.ctimeNs !== entry.ctimeNs ||
    info.dev !== entry.dev ||
    info.ino !== entry.ino ||
    info.mtimeNs !== entry.mtimeNs ||
    info.size !== entry.size
  ) {
    throw new Error(message);
  }
}

async function openSourceEntry(
  root: string,
  entry: SourceEntry,
): Promise<Readable> {
  const path = join(root, entry.name);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertSourceEntryUnchanged(
      await handle.stat({ bigint: true }),
      entry,
      `source entry changed: ${entry.name}`,
    );
    const stream = createBoundedSourceStream(handle, entry);
    handle = undefined;
    return stream;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          `source entry changed and could not be closed: ${entry.name}`,
        );
      }
    }
    if (error instanceof Error && /source entry changed/i.test(error.message)) {
      throw error;
    }
    throw new Error(`source entry changed: ${entry.name}`, { cause: error });
  }
}

function createBoundedSourceStream(
  handle: FileHandle,
  entry: SourceEntry,
): Readable {
  const size = Number(entry.size);
  let position = 0;
  let reading = false;
  let handleClosed = false;
  const digest = createHash("sha256");

  const closeHandle = async (): Promise<void> => {
    if (handleClosed) return;
    handleClosed = true;
    await handle.close();
  };
  const stream = new Readable({
    read() {
      if (reading) return;
      reading = true;
      void pump();
    },
    destroy(error, callback) {
      void closeHandle().then(
        () => callback(error),
        (closeError) => {
          callback(
            error === null
              ? closeError
              : new AggregateError(
                  [error, closeError],
                  `source entry changed and could not be closed: ${entry.name}`,
                ),
          );
        },
      );
    },
  });

  const pump = async (): Promise<void> => {
    try {
      while (!stream.destroyed) {
        if (position < size) {
          const length = Math.min(SOURCE_READ_CHUNK_BYTES, size - position);
          const buffer = Buffer.allocUnsafe(length);
          const result = await handle.read(buffer, 0, length, position);
          if (result.bytesRead === 0) {
            throw new Error(`source entry changed during read: ${entry.name}`);
          }
          position += result.bytesRead;
          digest.update(buffer.subarray(0, result.bytesRead));
          if (!stream.push(buffer.subarray(0, result.bytesRead))) {
            reading = false;
            return;
          }
          continue;
        }

        const probe = Buffer.allocUnsafe(1);
        const result = await handle.read(probe, 0, 1, position);
        if (result.bytesRead !== 0) {
          throw new Error(`source entry changed during read: ${entry.name}`);
        }
        if (digest.digest("hex") !== entry.digest) {
          throw new Error(`source entry changed during read: ${entry.name}`);
        }
        assertSourceEntryUnchanged(
          await handle.stat({ bigint: true }),
          entry,
          `source entry changed during read: ${entry.name}`,
        );
        await closeHandle();
        reading = false;
        stream.push(null);
        return;
      }
    } catch (error) {
      reading = false;
      stream.destroy(
        error instanceof Error
          ? error
          : new Error(`source entry changed during read: ${entry.name}`, {
              cause: error,
            }),
      );
    }
  };
  return stream;
}

async function assertStableDescriptorRuntime(
  outputParent: string,
): Promise<void> {
  let handle: FileHandle | undefined;
  const failures: unknown[] = [];
  try {
    handle = await open(
      outputParent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const actual = await readStableDescriptorPath(handle);
    if (actual !== outputParent) {
      throw new Error(
        `source archive stable descriptor path resolved unexpectedly: ${actual}`,
      );
    }
  } catch (error) {
    failures.push(error);
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (closeError) {
      failures.push(closeError);
    }
  }
  if (failures.length > 0) {
    throw combineFailures(
      failures,
      "source archive stable descriptor path prerequisite is unavailable",
    );
  }
}

async function readStableDescriptorPath(handle: FileHandle): Promise<string> {
  if (process.platform !== "linux") {
    throw new Error(
      "source archive stable descriptor paths require Linux /proc/self/fd",
    );
  }
  let actual: string;
  try {
    actual = await readlink(`/proc/self/fd/${handle.fd}`);
  } catch (error) {
    throw new Error("source archive stable descriptor path is unavailable", {
      cause: error,
    });
  }
  if (!isAbsolute(actual)) {
    throw new Error(
      `source archive stable descriptor path must be absolute: ${actual}`,
    );
  }
  return actual;
}

async function locateTemporary(
  handle: FileHandle,
  expectedPath: string,
  requireStableDescriptors: boolean,
): Promise<TemporaryLocation> {
  const actualPath = requireStableDescriptors
    ? await readStableDescriptorPath(handle)
    : expectedPath;
  if (basename(actualPath) !== basename(expectedPath)) {
    throw new Error(
      `source archive temporary descriptor resolved unexpectedly: ${actualPath}`,
    );
  }
  const handleInfo = await handle.stat({ bigint: true });
  const pathInfo = await lstat(actualPath, { bigint: true });
  if (
    !handleInfo.isFile() ||
    !pathInfo.isFile() ||
    handleInfo.dev !== pathInfo.dev ||
    handleInfo.ino !== pathInfo.ino ||
    handleInfo.size !== pathInfo.size
  ) {
    throw new Error("source archive temporary descriptor path changed");
  }
  return {
    dev: handleInfo.dev,
    ino: handleInfo.ino,
    path: actualPath,
    size: handleInfo.size,
  };
}

async function assertTemporaryUnchanged(
  expected: TemporaryLocation,
): Promise<void> {
  const actual = await lstat(expected.path, { bigint: true });
  if (
    !actual.isFile() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size
  ) {
    throw new Error("source archive temporary path changed");
  }
}

async function assertOutputParentUnchanged(
  requestedParent: string,
  expected: DirectoryIdentity,
): Promise<void> {
  try {
    const actualPath = await realpath(requestedParent);
    const actual = await stat(requestedParent, { bigint: true });
    if (
      actualPath !== expected.path ||
      !actual.isDirectory() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino
    ) {
      throw new Error("source archive output parent changed");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /output parent changed/i.test(error.message)
    ) {
      throw error;
    }
    throw new Error("source archive output parent changed", { cause: error });
  }
}

async function writeZip(
  root: string,
  files: readonly SourceEntry[],
  temporaryHandle: FileHandle,
): Promise<void> {
  await new Promise<void>((resolveDone, reject) => {
    const zip = new ZipFile();
    const output = createHandleWriteStream(temporaryHandle);
    let failure: unknown;
    let failed = false;
    let finished = false;
    let settled = false;
    let activeSource: Readable | undefined;

    const fail = (error: unknown): void => {
      if (settled || failed) return;
      failed = true;
      failure = error;
      activeSource?.destroy();
      (zip.outputStream as Readable).destroy();
      output.destroy();
    };
    output.once("finish", () => {
      finished = true;
    });
    output.on("error", fail);
    zip.on("error", fail);
    zip.outputStream.on("error", fail);
    output.once("close", () => {
      if (settled) return;
      if (!finished && !failed) {
        fail(new Error("source archive output closed before completion"));
      }
      settled = true;
      if (failed) {
        reject(failure);
        return;
      }
      resolveDone();
    });
    try {
      zip.outputStream.pipe(output);
      for (const file of files) {
        zip.addReadStreamLazy(
          file.name.split(sep).join("/"),
          {
            mtime: fixedZipTime,
            mode: 0o100644,
            compress: true,
            forceDosTimestamp: true,
            size: Number(file.size),
          },
          (callback) => {
            void openSourceEntry(root, file).then(
              (stream) => {
                if (failed || settled) {
                  stream.destroy();
                  return;
                }
                activeSource = stream;
                stream.once("close", () => {
                  if (activeSource === stream) activeSource = undefined;
                });
                stream.once("error", fail);
                try {
                  callback(null, stream);
                } catch (error) {
                  stream.destroy();
                  fail(error);
                }
              },
              (error) => {
                if (failed || settled) return;
                try {
                  callback(error, undefined as never);
                } catch (callbackError) {
                  fail(callbackError);
                }
              },
            );
          },
        );
      }
      zip.end({ forceZip64Format: false, comment: "" });
    } catch (error) {
      fail(error);
    }
  });
}

function createHandleWriteStream(handle: FileHandle): Writable {
  let position = 0;
  let pendingWrite: Promise<number> | undefined;
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pendingWrite = writeAll(handle, chunk, position);
      void pendingWrite.then(
        (written) => {
          position += written;
          callback();
        },
        (error) => callback(error),
      );
    },
    destroy(error, callback) {
      // close must follow the pending descriptor write before temporary cleanup.
      void Promise.resolve(pendingWrite).then(
        () => callback(error),
        (writeError) => callback(error ?? writeError),
      );
    },
  });
}

async function writeAll(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<number> {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(
      buffer,
      written,
      buffer.length - written,
      position + written,
    );
    if (result.bytesWritten === 0) {
      throw new Error("source archive output write made no progress");
    }
    written += result.bytesWritten;
  }
  return written;
}

function combineFailures(
  failures: readonly unknown[],
  message: string,
): unknown {
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}
