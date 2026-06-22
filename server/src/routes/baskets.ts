import { Router } from "express";
import { readBasketStore, writeBasketStore, type Basket } from "../basketConfig";

const router = Router();

function parseBasket(body: unknown, idOverride?: string): Basket | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b["name"] !== "string" || !b["name"].trim()) return null;
  return {
    id: idOverride ?? (typeof b["id"] === "string" && b["id"] ? b["id"] : `basket-${Date.now().toString(36)}`),
    name: (b["name"] as string).trim(),
    symbols: Array.isArray(b["symbols"])
      ? (b["symbols"] as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [],
  };
}

router.get("/baskets", (_req, res) => {
  res.json(readBasketStore().baskets);
});

router.post("/baskets", (req, res) => {
  const basket = parseBasket(req.body);
  if (!basket) { res.status(400).json({ error: "name required" }); return; }
  const store = readBasketStore();
  store.baskets.push(basket);
  writeBasketStore(store);
  res.status(201).json(basket);
});

router.put("/baskets/:id", (req, res) => {
  const basket = parseBasket(req.body, req.params.id);
  if (!basket) { res.status(400).json({ error: "name required" }); return; }
  const store = readBasketStore();
  const idx = store.baskets.findIndex((b) => b.id === req.params.id);
  if (idx < 0) { res.status(404).json({ error: "Not found" }); return; }
  store.baskets[idx] = basket;
  writeBasketStore(store);
  res.json(basket);
});

router.delete("/baskets/:id", (req, res) => {
  const store = readBasketStore();
  store.baskets = store.baskets.filter((b) => b.id !== req.params.id);
  writeBasketStore(store);
  res.json({ ok: true });
});

export default router;
