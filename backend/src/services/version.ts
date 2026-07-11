import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);
const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serviceDir, "../../..");
const UPDATE_CACHE_MS = 5 * 60_000;
const UPDATE_TIMEOUT_MS = 6_000;

type VersionCommit = {
  sha: string;
  short_sha: string;
  title: string;
  committed_at: string | null;
  url: string | null;
};

let cachedRemote: { expiresAt: number; commits: VersionCommit[]; error: string | null } | null = null;

export async function getVersionInfo(force = false) {
  const [version, commit] = await Promise.all([readVersion(), readLocalCommit()]);
  const remote = await readRemoteVersions(force);
  const latest = remote.commits[0] ?? null;
  const updateAvailable = commit.sha && latest?.sha ? !sameCommitSha(commit.sha, latest.sha) : null;
  const buildVersion = commit.shortSha ? `${version}+${commit.shortSha}` : version;
  return {
    version,
    build_version: buildVersion,
    commit_sha: commit.sha || null,
    short_sha: commit.shortSha || null,
    branch: commit.branch || null,
    repository: config.APP_REPOSITORY,
    update_branch: config.APP_UPDATE_BRANCH,
    latest_version: latest,
    update_available: updateAvailable,
    check_error: remote.error,
    checked_at: new Date().toISOString(),
    recent_versions: remote.commits.length > 0 ? remote.commits : commit.recent
  };
}

function sameCommitSha(left: string, right: string) {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  return Boolean(normalizedLeft && normalizedRight) &&
    (normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft));
}

async function readVersion() {
  for (const filename of [path.join(projectRoot, "VERSION"), path.join(projectRoot, "..", "VERSION")]) {
    try {
      const value = (await readFile(filename, "utf8")).trim();
      if (value) return value;
    } catch {
      // Try the next location.
    }
  }
  return config.APP_VERSION;
}

async function readLocalCommit() {
  const envSha = config.APP_COMMIT_SHA.trim();
  const fileHead = await readGitHead();
  const sha = envSha || await gitValue(["rev-parse", "HEAD"]) || fileHead.sha;
  const shortSha = sha ? sha.slice(0, 8) : "";
  const branch = await gitValue(["rev-parse", "--abbrev-ref", "HEAD"]) || fileHead.branch;
  const log = await gitValue(["log", "-10", "--pretty=format:%H%x1f%h%x1f%aI%x1f%s%x1e"]);
  return {
    sha,
    shortSha,
    branch,
    recent: parseLocalLog(log)
  };
}

async function readGitHead() {
  const gitDir = await resolveGitDirectory();
  try {
    const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    if (!head.startsWith("ref:")) {
      return { sha: head, branch: "" };
    }
    const ref = head.slice(4).trim();
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    const looseSha = await readFile(path.join(gitDir, ...ref.split("/")), "utf8").then((value) => value.trim()).catch(() => "");
    if (looseSha) {
      return { sha: looseSha, branch };
    }
    const packed = await readFile(path.join(gitDir, "packed-refs"), "utf8").catch(() => "");
    const packedSha = packed.split(/\r?\n/).find((line) => line.endsWith(` ${ref}`))?.split(" ", 1)[0] ?? "";
    return { sha: packedSha, branch };
  } catch {
    return { sha: "", branch: "" };
  }
}

async function resolveGitDirectory() {
  const marker = path.join(projectRoot, ".git");
  try {
    const value = (await readFile(marker, "utf8")).trim();
    const match = value.match(/^gitdir:\s*(.+)$/i);
    return match ? path.resolve(projectRoot, match[1]!) : marker;
  } catch {
    return marker;
  }
}

async function gitValue(args: string[]) {
  try {
    const result = await execFileAsync("git", args, { cwd: projectRoot, timeout: 3_000, windowsHide: true });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

async function readRemoteVersions(force: boolean) {
  if (!force && cachedRemote && cachedRemote.expiresAt > Date.now()) {
    return cachedRemote;
  }
  try {
    const response = await fetch(
      `https://api.github.com/repos/${config.APP_REPOSITORY}/commits?sha=${encodeURIComponent(config.APP_UPDATE_BRANCH)}&per_page=10`,
      {
        headers: { accept: "application/vnd.github+json", "user-agent": "dt-manager-version-check" },
        signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS)
      }
    );
    if (!response.ok) {
      throw new Error(`GitHub update check failed: ${response.status}`);
    }
    const payload = await response.json() as Array<Record<string, unknown>>;
    const commits = payload.map(normalizeRemoteCommit).filter((item): item is VersionCommit => Boolean(item));
    cachedRemote = { expiresAt: Date.now() + UPDATE_CACHE_MS, commits, error: null };
  } catch (error) {
    cachedRemote = {
      expiresAt: Date.now() + 30_000,
      commits: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
  return cachedRemote;
}

function normalizeRemoteCommit(value: Record<string, unknown>): VersionCommit | null {
  const sha = typeof value.sha === "string" ? value.sha : "";
  const commit = value.commit && typeof value.commit === "object" ? value.commit as Record<string, unknown> : {};
  const author = commit.author && typeof commit.author === "object" ? commit.author as Record<string, unknown> : {};
  if (!sha) return null;
  return {
    sha,
    short_sha: sha.slice(0, 8),
    title: typeof commit.message === "string" ? (commit.message.split(/\r?\n/, 1)[0] || sha.slice(0, 8)) : sha.slice(0, 8),
    committed_at: typeof author.date === "string" ? author.date : null,
    url: typeof value.html_url === "string" ? value.html_url : null
  };
}

function parseLocalLog(value: string): VersionCommit[] {
  return value.split("\x1e").map((row) => row.trim()).filter(Boolean).map((row) => {
    const [sha = "", shortSha = "", committedAt = "", title = ""] = row.split("\x1f");
    return { sha, short_sha: shortSha, title, committed_at: committedAt || null, url: null };
  });
}
