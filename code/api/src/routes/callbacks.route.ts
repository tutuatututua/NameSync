import { Router } from 'express';
import { CallbacksController } from '../controllers/callbacks.controller';

const router = Router();

// POST /api/callbacks/comparison-results - Receive batch results from workflow
router.post('/comparison-results', CallbacksController.receiveComparisonResults);

export default router;
