import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Storage ──────────────────────────────────────────────────────────────────

const CODEGRAPH_DIR = join(homedir(), ".codegraph");
const PORTFOLIOS_FILE = join(CODEGRAPH_DIR, "portfolios.json");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PortfolioEntry {
  name: string;
  description?: string;
  repos: string[];
  created_at: number;
}

interface PortfoliosFile {
  portfolios: PortfolioEntry[];
}

// ─── IO ───────────────────────────────────────────────────────────────────────

function readPortfolios(): PortfoliosFile {
  if (!existsSync(PORTFOLIOS_FILE)) return { portfolios: [] };
  try {
    return JSON.parse(readFileSync(PORTFOLIOS_FILE, "utf8")) as PortfoliosFile;
  } catch {
    return { portfolios: [] };
  }
}

function savePortfolios(data: PortfoliosFile): void {
  mkdirSync(CODEGRAPH_DIR, { recursive: true });
  writeFileSync(PORTFOLIOS_FILE, JSON.stringify(data, null, 2));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function createPortfolio(name: string, description?: string): void {
  const data = readPortfolios();
  if (data.portfolios.find((p) => p.name === name)) {
    throw new Error(`Portfolio "${name}" already exists`);
  }
  data.portfolios.push({
    name,
    description,
    repos: [],
    created_at: Date.now(),
  });
  savePortfolios(data);
}

export function addRepoToPortfolio(name: string, repoPath: string): void {
  const data = readPortfolios();
  const portfolio = data.portfolios.find((p) => p.name === name);
  if (!portfolio) throw new Error(`Portfolio "${name}" not found`);
  if (!portfolio.repos.includes(repoPath)) {
    portfolio.repos.push(repoPath);
    savePortfolios(data);
  }
}

export function removeRepoFromPortfolio(name: string, repoPath: string): void {
  const data = readPortfolios();
  const portfolio = data.portfolios.find((p) => p.name === name);
  if (!portfolio) throw new Error(`Portfolio "${name}" not found`);
  portfolio.repos = portfolio.repos.filter((r) => r !== repoPath);
  savePortfolios(data);
}

export function deletePortfolio(name: string): void {
  const data = readPortfolios();
  const idx = data.portfolios.findIndex((p) => p.name === name);
  if (idx === -1) throw new Error(`Portfolio "${name}" not found`);
  data.portfolios.splice(idx, 1);
  savePortfolios(data);
}

export function listPortfolios(): PortfolioEntry[] {
  return readPortfolios().portfolios;
}

export function getPortfolio(name: string): PortfolioEntry | null {
  return readPortfolios().portfolios.find((p) => p.name === name) ?? null;
}

/** Returns the first portfolio name that contains repoPath, or null if standalone. */
export function findPortfolioForRepo(repoPath: string): string | null {
  const data = readPortfolios();
  return data.portfolios.find((p) => p.repos.includes(repoPath))?.name ?? null;
}

/** Returns all portfolio names a repo belongs to (a repo can be in multiple). */
export function findPortfoliosForRepo(repoPath: string): string[] {
  return readPortfolios()
    .portfolios.filter((p) => p.repos.includes(repoPath))
    .map((p) => p.name);
}
