import fs from "fs";
import path from "path";

export interface ScheduledJob {
  id: string;
  name: string;
  emails: string[];
  symbols: string[];
  basketLabel: string;
  scheduleTime: string;
  frequency: "daily" | "weekly";
  weekDay?: number; // 0=Sun, 1=Mon … 6=Sat (only for weekly)
  enabled: boolean;
  subject?: string;
  bodyNote?: string;
}

export interface EmailStore {
  jobs: ScheduledJob[];
}

const STORE_PATH = path.join(process.cwd(), "data", "email-jobs.json");

export function readEmailStore(): EmailStore {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "jobs" in parsed &&
      Array.isArray((parsed as Record<string, unknown>)["jobs"])
    ) {
      return parsed as EmailStore;
    }
    return { jobs: [] };
  } catch {
    return { jobs: [] };
  }
}

export function writeEmailStore(store: EmailStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function readJob(id: string): ScheduledJob | undefined {
  return readEmailStore().jobs.find((j) => j.id === id);
}

export function upsertJob(job: ScheduledJob): void {
  const store = readEmailStore();
  const idx = store.jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) store.jobs[idx] = job;
  else store.jobs.push(job);
  writeEmailStore(store);
}

export function deleteJob(id: string): void {
  const store = readEmailStore();
  store.jobs = store.jobs.filter((j) => j.id !== id);
  writeEmailStore(store);
}
