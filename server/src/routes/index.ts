import { Router, type IRouter } from "express";
import healthRouter from "./health";
import screenerRouter from "./screener";
import presetsRouter from "./presets";
import emailRouter from "./email";
import basketsRouter from "./baskets";
import preferencesRouter from "./preferences";
import anthropicRouter from "./anthropic";
import backtestRouter from "./backtest";
import tickerHistoryRouter from "./tickerHistory";
import signalAnalysisRouter from "./signalAnalysis";

const router: IRouter = Router();

router.use(healthRouter);
router.use(screenerRouter);
router.use(presetsRouter);
router.use(emailRouter);
router.use(basketsRouter);
router.use(preferencesRouter);
router.use(anthropicRouter);
router.use(backtestRouter);
router.use(tickerHistoryRouter);
router.use(signalAnalysisRouter);

export default router;
