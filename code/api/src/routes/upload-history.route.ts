import { Router } from 'express';
import { UploadHistoryController } from '../controllers/upload-history.controller';

const router = Router();

// GET /api/upload-history - Get all upload history (paginated)
router.get('/', UploadHistoryController.list);

// GET /api/upload-history/by-source/:sourceType - Get upload history by source type (facebook|company)
router.get('/by-source/:sourceType', UploadHistoryController.listBySourceType);

// GET /api/upload-history/:id - Get single upload history record
router.get('/:id', UploadHistoryController.getById);

// POST /api/upload-history - Create new upload history record
router.post('/', UploadHistoryController.create);

// DELETE /api/upload-history/:id - Delete upload history record
router.delete('/:id', UploadHistoryController.delete);

// DELETE /api/upload-history/by-source/:sourceType - Delete all history for a source type
router.delete('/by-source/:sourceType', UploadHistoryController.deleteBySourceType);

export default router;
