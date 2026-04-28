import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const ROOT = process.env.FLAMECAST_LOG_DIR
  ? resolve(process.env.FLAMECAST_LOG_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../../.flamecast");

const RAW_DIR = join(ROOT, "raw");
const LOGS_DIR = join(ROOT, "logs");
const SESSIONS_DIR = join(ROOT, "sessions");

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(
  `${ESC}k[^${ESC}]*(?:${ESC}\\\\)|${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)`,
  "g",
);

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

interface LoggerEntry {
  fcSessionId: string;
  rawPath: string;
  tail: ChildProcess;
  buffer: string;
  currentClaudeSessionId: string | null;
  seenUuidsByClaudeSession: Map<string, Set<string>>;
  writeQueue: Promise<void>;
}

export interface SessionLoggerEvents {
  chunk: (fcSessionId: string, chunk: string) => void;
}

export class SessionLogger extends EventEmitter {
  private readonly entries = new Map<string, LoggerEntry>();
  private readonly pendingUserMessages = new Map<string, string[]>();
  private dirsReady = false;

  static rootDir(): string {
    return ROOT;
  }
  static logsDir(): string {
    return LOGS_DIR;
  }

  async ensureRootDir(): Promise<string> {
    await mkdir(ROOT, { recursive: true });
    return ROOT;
  }

  recordPendingUserMessage(fcSessionId: string, text: string): void {
    const arr = this.pendingUserMessages.get(fcSessionId) ?? [];
    arr.push(text);
    this.pendingUserMessages.set(fcSessionId, arr);
  }

  private async flushPendingUserMessages(entry: LoggerEntry): Promise<void> {
    const claudeSessionId = entry.currentClaudeSessionId;
    if (!claudeSessionId) return;
    const pending = this.pendingUserMessages.get(entry.fcSessionId);
    if (!pending || pending.length === 0) return;
    this.pendingUserMessages.delete(entry.fcSessionId);

    const path = join(LOGS_DIR, `${claudeSessionId}.ndjson`);
    let dedupSet = entry.seenUuidsByClaudeSession.get(claudeSessionId);
    if (!dedupSet) {
      dedupSet = new Set<string>();
      entry.seenUuidsByClaudeSession.set(claudeSessionId, dedupSet);
    }

    for (const text of pending) {
      const event = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text }],
        },
        uuid: randomUUID(),
        session_id: claudeSessionId,
      };
      const line = JSON.stringify(event);
      dedupSet.add(event.uuid);
      await appendFile(path, `${line}\n`);
      this.emit("chunk", entry.fcSessionId, `${line}\n`);
    }
  }

  override on<K extends keyof SessionLoggerEvents>(
    event: K,
    listener: SessionLoggerEvents[K],
  ): this {
    return super.on(event, listener);
  }

  private async ensureDirs(): Promise<void> {
    if (this.dirsReady) return;
    await mkdir(RAW_DIR, { recursive: true });
    await mkdir(LOGS_DIR, { recursive: true });
    await mkdir(SESSIONS_DIR, { recursive: true });
    this.dirsReady = true;
  }

  private async recordFcToClaudeMapping(
    fcSessionId: string,
    claudeSessionId: string,
  ): Promise<void> {
    if (!/^fc_[a-zA-Z0-9]+$/.test(fcSessionId)) return;
    const path = join(SESSIONS_DIR, `${fcSessionId}.json`);
    let claudeSessionIds: string[] = [];
    try {
      const content = await readFile(path, "utf-8");
      const parsed = JSON.parse(content) as { claudeSessionIds?: string[] };
      if (Array.isArray(parsed.claudeSessionIds)) {
        claudeSessionIds = parsed.claudeSessionIds;
      }
    } catch {
      // file doesn't exist yet
    }
    if (claudeSessionIds.includes(claudeSessionId)) return;
    claudeSessionIds.push(claudeSessionId);
    await writeFile(path, JSON.stringify({ claudeSessionIds }, null, 2));
  }

  async getClaudeSessionsForFc(fcSessionId: string): Promise<string[]> {
    if (!/^fc_[a-zA-Z0-9]+$/.test(fcSessionId)) return [];
    const path = join(SESSIONS_DIR, `${fcSessionId}.json`);
    try {
      const content = await readFile(path, "utf-8");
      const parsed = JSON.parse(content) as { claudeSessionIds?: string[] };
      if (Array.isArray(parsed.claudeSessionIds)) {
        return parsed.claudeSessionIds;
      }
    } catch {
      // ignore
    }
    return [];
  }

  async getEventsForFc(fcSessionId: string): Promise<unknown[]> {
    const claudeSessionIds = await this.getClaudeSessionsForFc(fcSessionId);
    const events: unknown[] = [];
    for (const claudeId of claudeSessionIds) {
      const content = await this.readClaudeSession(claudeId);
      if (!content) continue;
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed));
        } catch {
          // skip
        }
      }
    }
    return events;
  }

  async start(fcSessionId: string): Promise<string> {
    const existing = this.entries.get(fcSessionId);
    if (existing) return existing.rawPath;

    await this.ensureDirs();
    const rawPath = join(RAW_DIR, `${fcSessionId}.log`);

    // If we've never logged this session before, scrape pane scrollback so
    // chats made before the logger was attached still hydrate. Done BEFORE
    // pipe-pane is opened to avoid double-counting events.
    let initialClaudeSessionId: string | null = null;
    const priorClaudeSessions = await this.getClaudeSessionsForFc(fcSessionId);
    if (priorClaudeSessions.length === 0) {
      initialClaudeSessionId = await this.warmupFromPane(fcSessionId);
    } else {
      initialClaudeSessionId =
        priorClaudeSessions[priorClaudeSessions.length - 1] ?? null;
    }

    await writeFile(rawPath, "");

    await exec("tmux", [
      "pipe-pane",
      "-o",
      "-t",
      fcSessionId,
      `cat >> ${rawPath}`,
    ]);

    const tail = spawn("tail", ["-f", "-n", "+1", rawPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const entry: LoggerEntry = {
      fcSessionId,
      rawPath,
      tail,
      buffer: "",
      currentClaudeSessionId: initialClaudeSessionId,
      seenUuidsByClaudeSession: new Map(),
      writeQueue: Promise.resolve(),
    };
    if (initialClaudeSessionId) {
      // Pre-seed the dedup set with uuids already on disk for this claude
      // session, so re-tailing/pane replays don't double-write.
      try {
        const existing = await this.readClaudeSession(initialClaudeSessionId);
        if (existing) {
          const set = new Set<string>();
          for (const line of existing.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
              const ev = JSON.parse(t) as Record<string, unknown>;
              if (typeof ev.uuid === "string") set.add(ev.uuid);
            } catch {
              // skip
            }
          }
          entry.seenUuidsByClaudeSession.set(initialClaudeSessionId, set);
        }
      } catch {
        // ignore
      }
    }
    this.entries.set(fcSessionId, entry);

    tail.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.emit("chunk", fcSessionId, text);
      entry.writeQueue = entry.writeQueue
        .then(() => this.persistChunk(entry, text))
        .catch((err) => {
          console.error(
            `[session-logger] persist error for ${fcSessionId}:`,
            err,
          );
        });
    });

    tail.on("exit", () => {
      this.entries.delete(fcSessionId);
    });

    return rawPath;
  }

  private async warmupFromPane(fcSessionId: string): Promise<string | null> {
    let stdout: string;
    try {
      const result = await exec("tmux", [
        "capture-pane",
        "-t",
        fcSessionId,
        "-p",
        "-J",
        "-S",
        "-",
      ]);
      stdout = result.stdout;
    } catch {
      return null;
    }
    if (!stdout) return null;

    const seenUuids = new Set<string>();
    let currentClaudeSessionId: string | null = null;
    for (const rawLine of stripAnsi(stdout).split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed.startsWith("{")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const obj = parsed as Record<string, unknown>;

      if (
        obj.type === "system" &&
        obj.subtype === "init" &&
        typeof obj.session_id === "string" &&
        obj.session_id !== currentClaudeSessionId
      ) {
        currentClaudeSessionId = obj.session_id;
        await this.recordFcToClaudeMapping(fcSessionId, obj.session_id);
        // Reset uuid dedup window for the new claude session so we don't
        // accidentally drop events whose uuid was previously seen.
        seenUuids.clear();
      }

      if (!currentClaudeSessionId) continue;

      const uuid = typeof obj.uuid === "string" ? (obj.uuid as string) : null;
      if (uuid && seenUuids.has(uuid)) continue;
      if (uuid) seenUuids.add(uuid);

      const path = join(LOGS_DIR, `${currentClaudeSessionId}.ndjson`);
      await appendFile(path, `${trimmed}\n`);
    }
    return currentClaudeSessionId;
  }

  private async persistChunk(entry: LoggerEntry, chunk: string): Promise<void> {
    entry.buffer += stripAnsi(chunk);
    const lines = entry.buffer.split("\n");
    entry.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const obj = parsed as Record<string, unknown>;

      let isNewClaudeSession = false;
      if (
        obj.type === "system" &&
        obj.subtype === "init" &&
        typeof obj.session_id === "string" &&
        obj.session_id !== entry.currentClaudeSessionId
      ) {
        entry.currentClaudeSessionId = obj.session_id;
        await this.recordFcToClaudeMapping(entry.fcSessionId, obj.session_id);
        isNewClaudeSession = true;
      }

      if (!entry.currentClaudeSessionId) continue;

      const uuid = typeof obj.uuid === "string" ? (obj.uuid as string) : null;
      let dedupSet = entry.seenUuidsByClaudeSession.get(
        entry.currentClaudeSessionId,
      );
      if (!dedupSet) {
        dedupSet = new Set<string>();
        entry.seenUuidsByClaudeSession.set(
          entry.currentClaudeSessionId,
          dedupSet,
        );
      }
      if (uuid && dedupSet.has(uuid)) continue;
      if (uuid) dedupSet.add(uuid);

      const path = join(LOGS_DIR, `${entry.currentClaudeSessionId}.ndjson`);
      await appendFile(path, `${trimmed}\n`);

      if (isNewClaudeSession) {
        await this.flushPendingUserMessages(entry);
      }
    }
  }

  async stop(fcSessionId: string): Promise<void> {
    const entry = this.entries.get(fcSessionId);
    if (!entry) return;
    this.entries.delete(fcSessionId);
    try {
      entry.tail.kill();
    } catch {
      // ignore
    }
    try {
      await exec("tmux", ["pipe-pane", "-t", fcSessionId]);
    } catch {
      // session may already be dead
    }
    try {
      await entry.writeQueue;
    } catch {
      // ignore
    }
    try {
      await unlink(entry.rawPath);
    } catch {
      // ignore
    }
  }

  rawPath(fcSessionId: string): string | null {
    return this.entries.get(fcSessionId)?.rawPath ?? null;
  }

  async listClaudeSessions(): Promise<string[]> {
    try {
      await this.ensureDirs();
      const files = await readdir(LOGS_DIR);
      return files
        .filter((f) => f.endsWith(".ndjson"))
        .map((f) => f.slice(0, -".ndjson".length));
    } catch {
      return [];
    }
  }

  async readClaudeSession(claudeSessionId: string): Promise<string | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(claudeSessionId)) return null;
    try {
      const path = join(LOGS_DIR, `${claudeSessionId}.ndjson`);
      return await readFile(path, "utf-8");
    } catch {
      return null;
    }
  }
}
