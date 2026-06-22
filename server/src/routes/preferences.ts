import { Router } from "express";
import { readPreferences, writePreferences } from "../preferencesConfig";

const router = Router();

router.get("/preferences", (_req, res) => {
  res.json(readPreferences());
});

router.put("/preferences", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const current = readPreferences();

  if ("config" in body && body["config"] && typeof body["config"] === "object") {
    current.config = body["config"] as Record<string, unknown>;
  }
  if ("hiddenCols" in body && Array.isArray(body["hiddenCols"])) {
    current.hiddenCols = (body["hiddenCols"] as unknown[]).filter((c): c is string => typeof c === "string");
  }

  writePreferences(current);
  res.json(current);
});

export default router;
