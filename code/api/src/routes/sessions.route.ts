import { Router } from 'express';
import { SessionsController } from '../controllers/sessions.controller';

const router = Router();

// GET /api/sessions - List available sessions for "continue from existing"
router.get('/', SessionsController.list);

// GET /api/sessions/latest - Most recent session eligible to (re)trigger comparison
// (must be registered before "/:id" so "latest" isn't captured as an id)
router.get('/latest', SessionsController.getLatest);

// GET /api/sessions/:id - Get session details for preview
router.get('/:id', SessionsController.getById);

export default router;
