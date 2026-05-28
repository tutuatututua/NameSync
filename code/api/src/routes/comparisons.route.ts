import { Router } from 'express';
import { ComparisonsController, upload } from '../controllers/comparisons.controller';
import { CompareController } from '../controllers/compare.controller';
import { FacebookDataController } from '../controllers/facebook-data.controller';
import { CompanyDataController } from '../controllers/company-data.controller';

const router = Router();

// Multer fields configuration
const uploadFields = upload.fields([
  { name: 'companyFile', maxCount: 1 },
  { name: 'facebookFile', maxCount: 1 }
]);

// POST /api/comparisons - Start new comparison with uploaded files
router.post('/', uploadFields, ComparisonsController.create);

// POST /api/comparisons/:id/merge - Merge new files with existing session
router.post('/:id/merge', uploadFields, ComparisonsController.merge);

// POST /api/comparisons/:id/send-webhook - Send data to external webhooks
router.post('/:id/send-webhook', ComparisonsController.sendWebhook);

// POST /api/comparisons/:id/compare - Trigger comparison after uploads complete
router.post('/:id/compare', CompareController.triggerComparison);

// GET /api/comparisons/:id/results - Get stored comparison match results
router.get('/:id/results', ComparisonsController.getResults);

// GET /api/comparisons/:id/company-data - Get paginated company data
router.get('/:id/company-data', ComparisonsController.getCompanyData);

// GET /api/comparisons/:id/facebook-data - Get paginated facebook data
router.get('/:id/facebook-data', ComparisonsController.getFacebookData);

// GET /api/comparisons/facebook-data/all - Get all facebook data across sessions
router.get('/facebook-data/all', FacebookDataController.getAllFacebookData);

// GET /api/comparisons/company-data/all - Get all company data across sessions
router.get('/company-data/all', CompanyDataController.getAllCompanyData);

export default router;
