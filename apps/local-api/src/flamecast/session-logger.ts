import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const ROOT = process.env.FLAMECAST_LOG_DIR
  ? resolve(process.env.FLAMECAST_LOG_DIR)
  : resolve(homedir(), ".flamecast");

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
  chatId: string;
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

interface PendingUserMessage {
  uuid: string;
  text: string;
}

export interface ChatSummary {
  chatId: string;
  claudeSessionIds: string[];
  terminalSessionIds: string[];
  created: string;
  lastActivity: string;
}

interface ChatMetadata {
  chatId?: string;
  claudeSessionIds?: string[];
  terminalSessionIds?: string[];
  created?: string;
  lastActivity?: string;
}

function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is string => typeof v === "string");
}

export class SessionLogger extends EventEmitter {
  private readonly entries = new Map<string, LoggerEntry>();
  private readonly pendingUserMessages = new Map<
    string,
    PendingUserMessage[]
  >();
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
    const uuid = randomUUID();
    const entry = this.entries.get(fcSessionId);
    const claudeSessionId = entry?.currentClaudeSessionId ?? null;

    // Emit to WS clients immediately so the user message shows up in the UI
    // before claude has even started. We don't wait for system/init.
    const event = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
      uuid,
      session_id: claudeSessionId,
    };
    const line = JSON.stringify(event);
    this.emit("chunk", fcSessionId, `${line}\n`);

    if (entry && claudeSessionId) {
      // Follow-up message in an established claude session: persist
      // immediately to the existing NDJSON. Resumed sessions reuse the same
      // session_id so we don't depend on a new system/init firing.
      let dedupSet = entry.seenUuidsByClaudeSession.get(claudeSessionId);
      if (!dedupSet) {
        dedupSet = new Set<string>();
        entry.seenUuidsByClaudeSession.set(claudeSessionId, dedupSet);
      }
      dedupSet.add(uuid);
      const path = join(LOGS_DIR, `${claudeSessionId}.ndjson`);
      entry.writeQueue = entry.writeQueue
        .then(() => appendFile(path, `${line}\n`))
        .catch((err) => {
          console.error(
            `[session-logger] failed to persist user message for ${fcSessionId}:`,
            err,
          );
        });
      return;
    }

    // First message — claude hasn't emitted system/init yet, so we don't
    // know which NDJSON file to write to. Buffer with the uuid we already
    // emitted; flushPendingUserMessages will persist it on the first init.
    const arr = this.pendingUserMessages.get(fcSessionId) ?? [];
    arr.push({ uuid, text });
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

    for (const { uuid, text } of pending) {
      const event = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text }],
        },
        uuid,
        session_id: claudeSessionId,
      };
      const lineToPersist = JSON.stringify(event);
      dedupSet.add(uuid);
      // Persist only — we already emitted the WS chunk in
      // recordPendingUserMessage so the UI has it.
      await appendFile(path, `${lineToPersist}\n`);
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

  private async readChatMetadata(chatId: string): Promise<ChatMetadata | null> {
    if (!isSafeId(chatId)) return null;
    const path = join(SESSIONS_DIR, `${chatId}.json`);
    try {
      const content = await readFile(path, "utf-8");
      return JSON.parse(content) as ChatMetadata;
    } catch {
      return null;
    }
  }

  private async writeChatMetadata(
    chatId: string,
    metadata: ChatMetadata,
  ): Promise<void> {
    if (!isSafeId(chatId)) return;
    await this.ensureDirs();
    const now = new Date().toISOString();
    const normalized: ChatMetadata = {
      chatId,
      claudeSessionIds: uniqueStrings(metadata.claudeSessionIds),
      terminalSessionIds: uniqueStrings(metadata.terminalSessionIds),
      created: metadata.created ?? now,
      lastActivity: metadata.lastActivity ?? now,
    };
    const path = join(SESSIONS_DIR, `${chatId}.json`);
    await writeFile(path, JSON.stringify(normalized, null, 2));
  }

  async ensureChat(chatId: string): Promise<void> {
    if (!isSafeId(chatId)) return;
    const existing = await this.readChatMetadata(chatId);
    if (existing) return;
    await this.writeChatMetadata(chatId, {
      chatId,
      claudeSessionIds: [],
      terminalSessionIds: [],
    });
  }

  async addTerminalToChat(
    chatId: string,
    terminalSessionId: string,
  ): Promise<void> {
    if (!isSafeId(chatId) || !isSafeId(terminalSessionId)) return;
    const existing = (await this.readChatMetadata(chatId)) ?? {};
    const terminalSessionIds = uniqueStrings(existing.terminalSessionIds);
    if (!terminalSessionIds.includes(terminalSessionId)) {
      terminalSessionIds.push(terminalSessionId);
    }
    await this.writeChatMetadata(chatId, {
      ...existing,
      terminalSessionIds,
      lastActivity: new Date().toISOString(),
    });
  }

  async createChat(chatId: string, terminalSessionId?: string): Promise<void> {
    if (!isSafeId(chatId)) return;
    const existing = (await this.readChatMetadata(chatId)) ?? {};
    const terminalSessionIds = uniqueStrings(existing.terminalSessionIds);
    if (terminalSessionId && !terminalSessionIds.includes(terminalSessionId)) {
      terminalSessionIds.push(terminalSessionId);
    }
    await this.writeChatMetadata(chatId, {
      ...existing,
      terminalSessionIds,
    });
  }

  async touchChat(chatId: string): Promise<void> {
    if (!isSafeId(chatId)) return;
    const existing = (await this.readChatMetadata(chatId)) ?? {};
    await this.writeChatMetadata(chatId, {
      ...existing,
      lastActivity: new Date().toISOString(),
    });
  }

  private async recordChatToClaudeMapping(
    chatId: string,
    claudeSessionId: string,
  ): Promise<void> {
    if (!isSafeId(chatId)) return;
    const existing = (await this.readChatMetadata(chatId)) ?? {};
    const claudeSessionIds = uniqueStrings(existing.claudeSessionIds);
    if (claudeSessionIds.includes(claudeSessionId)) return;
    claudeSessionIds.push(claudeSessionId);
    await this.writeChatMetadata(chatId, {
      ...existing,
      claudeSessionIds,
      lastActivity: new Date().toISOString(),
    });
  }

  async getClaudeSessionsForFc(fcSessionId: string): Promise<string[]> {
    return this.getClaudeSessionsForChat(fcSessionId);
  }

  async getClaudeSessionsForChat(chatId: string): Promise<string[]> {
    if (!isSafeId(chatId)) return [];
    const metadata = await this.readChatMetadata(chatId);
    const claudeSessionIds = uniqueStrings(metadata?.claudeSessionIds);
    if (claudeSessionIds.length > 0) return claudeSessionIds;

    // Backward-compatible fallback: a bare Claude session id can act as a
    // chat id if its NDJSON log exists.
    const content = await this.readClaudeSession(chatId);
    return content ? [chatId] : [];
  }

  async getEventsForFc(fcSessionId: string): Promise<unknown[]> {
    return this.getEventsForChat(fcSessionId);
  }

  async getEventsForChat(chatId: string): Promise<unknown[]> {
    const claudeSessionIds = await this.getClaudeSessionsForChat(chatId);
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

  async listChats(): Promise<ChatSummary[]> {
    await this.ensureDirs();
    const files = await readdir(SESSIONS_DIR).catch(() => []);
    const chats: ChatSummary[] = [];
    const mappedClaudeIds = new Set<string>();

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const chatId = file.slice(0, -".json".length);
      if (!isSafeId(chatId)) continue;
      const metadata = (await this.readChatMetadata(chatId)) ?? {};
      const path = join(SESSIONS_DIR, file);
      const fallbackTime = await stat(path)
        .then((s) => s.mtime.toISOString())
        .catch(() => new Date(0).toISOString());
      const claudeSessionIds = uniqueStrings(metadata.claudeSessionIds);
      for (const id of claudeSessionIds) mappedClaudeIds.add(id);
      chats.push({
        chatId: metadata.chatId ?? chatId,
        claudeSessionIds,
        terminalSessionIds: uniqueStrings(metadata.terminalSessionIds),
        created: metadata.created ?? fallbackTime,
        lastActivity: metadata.lastActivity ?? fallbackTime,
      });
    }

    const logFiles = await readdir(LOGS_DIR).catch(() => []);
    for (const file of logFiles) {
      if (!file.endsWith(".ndjson")) continue;
      const claudeSessionId = file.slice(0, -".ndjson".length);
      if (!isSafeId(claudeSessionId) || mappedClaudeIds.has(claudeSessionId)) {
        continue;
      }
      const path = join(LOGS_DIR, file);
      const fallbackTime = await stat(path)
        .then((s) => s.mtime.toISOString())
        .catch(() => new Date(0).toISOString());
      chats.push({
        chatId: claudeSessionId,
        claudeSessionIds: [claudeSessionId],
        terminalSessionIds: [],
        created: fallbackTime,
        lastActivity: fallbackTime,
      });
    }

    return chats.sort((a, b) =>
      a.lastActivity < b.lastActivity
        ? 1
        : a.lastActivity > b.lastActivity
          ? -1
          : 0,
    );
  }

  async start(fcSessionId: string, chatId = fcSessionId): Promise<string> {
    const existing = this.entries.get(fcSessionId);
    if (existing) {
      existing.chatId = chatId;
      await this.addTerminalToChat(chatId, fcSessionId);
      return existing.rawPath;
    }

    await this.ensureDirs();
    await this.addTerminalToChat(chatId, fcSessionId);
    const rawPath = join(RAW_DIR, `${fcSessionId}.log`);

    // If we've never logged this session before, scrape pane scrollback so
    // chats made before the logger was attached still hydrate. Done BEFORE
    // pipe-pane is opened to avoid double-counting events.
    let initialClaudeSessionId: string | null = null;
    const priorClaudeSessions = await this.getClaudeSessionsForChat(chatId);
    if (priorClaudeSessions.length === 0) {
      initialClaudeSessionId = await this.warmupFromPane(fcSessionId, chatId);
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
      chatId,
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

  private async warmupFromPane(
    fcSessionId: string,
    chatId: string,
  ): Promise<string | null> {
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
        await this.recordChatToClaudeMapping(chatId, obj.session_id);
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
        await this.recordChatToClaudeMapping(entry.chatId, obj.session_id);
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
      await this.touchChat(entry.chatId);

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
