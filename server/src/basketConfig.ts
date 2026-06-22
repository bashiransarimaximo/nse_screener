import fs from "fs";
import path from "path";

export interface Basket {
  id: string;
  name: string;
  symbols: string[];
}

export interface BasketStore {
  baskets: Basket[];
}

const STORE_PATH = path.join(process.cwd(), "data", "baskets.json");

export function readBasketStore(): BasketStore {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "baskets" in parsed &&
      Array.isArray((parsed as Record<string, unknown>)["baskets"])
    ) {
      return parsed as BasketStore;
    }
    return { baskets: [] };
  } catch {
    return { baskets: [] };
  }
}

export function writeBasketStore(store: BasketStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}
