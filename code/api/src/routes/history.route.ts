import { Router } from 'express';
import { HistoryController } from '../controllers/history.controller';

const router = Router();

// GET /api/history - List saved comparison sessions
router.get('/', HistoryController.list);

// GET /api/history/search - Search sessions by name or date
router.get('/search', HistoryController.search);

// POST /api/history - Create a new history session
router.post('/', HistoryController.create);

// GET /api/history/:id - Get session details with results
router.get('/:id', HistoryController.getById);

// DELETE /api/history/:id - Delete a session
router.delete('/:id', HistoryController.delete);

// POST /api/history/:id/clone - Use session as base for new merge
router.post('/:id/clone', HistoryController.clone);

export default router;
