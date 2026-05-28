import { Router } from 'express';
import { SessionsController } from '../controllers/sessions.controller';

const router = Router();

// GET /api/sessions - List available sessions for "continue from existing"
router.get('/', SessionsController.list);

// GET /api/sessions/:id - Get session details for preview
router.get('/:id', SessionsController.getById);

export default router;
