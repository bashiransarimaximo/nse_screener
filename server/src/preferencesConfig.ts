import fs from "fs";
import path from "path";

export interface Preferences {
  config?: Record<string, unknown>;
  hiddenCols?: string[];
}

const STORE_PATH = path.join(process.cwd(), "data", "preferences.json");

export function readPreferences(): Preferences {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    return JSON.parse(raw) as Preferences;
  } catch {
    return {};
  }
}

export function writePreferences(prefs: Preferences): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(prefs, null, 2));
}
