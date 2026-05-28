import { Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import { UploadSessionModel } from '../models/upload-session.model';
import { CompanyDataModel } from '../models/company-data.model';
import { FacebookDataModel } from '../models/facebook-data.model';
import { ComparisonResultsModel } from '../models/comparison-results.model';
import { FileParserService, CompanyDataRecord, FacebookDataRecord } from '../services/file-parser.service';
import { WebhookService } from '../services/webhook.service';
import { WebSocketService } from '../services/websocket.service';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = crypto.randomUUID();
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  }
});

// File filter
const fileFilter = (req: any, file: any, cb: any) => {
  if (file.fieldname === 'companyFile') {
    if (!file.originalname.endsWith('.csv')) {
      return cb(new Error('Company file must be a CSV file'), false);
    }
  } else if (file.fieldname === 'facebookFile') {
    if (!file.originalname.endsWith('.json')) {
      return cb(new Error('Facebook file must be a JSON file'), false);
    }
  }
  cb(null, true);
};

// Multer upload configuration
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB max
  }
});

const normalizeKey = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

/** Return company rows not already in the DB, dropping intra-file repeats (keep first). */
async function dedupeCompany(records: CompanyDataRecord[]): Promise<CompanyDataRecord[]> {
  if (records.length === 0) return records;
  const existing = new Set(
    (await CompanyDataModel.getExistingKeys()).map(
      (k) => `${normalizeKey(k.company_name)}|${normalizeKey(k.person_name_th)}`
    )
  );
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = `${normalizeKey(r.company_name)}|${normalizeKey(r.person_name_th)}`;
    if (key === '|') return true; // no usable key — can't dedupe, keep it
    if (existing.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Return Facebook rows whose fb_name is not already in the DB, dropping intra-file repeats. */
async function dedupeFacebook(records: FacebookDataRecord[]): Promise<FacebookDataRecord[]> {
  if (records.length === 0) return records;
  const existing = new Set((await FacebookDataModel.getExistingFbNames()).map(normalizeKey));
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = normalizeKey(r.fb_name);
    if (key === '') return true; // no usable name — keep it
    if (existing.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class ComparisonsController {
  /**
   * POST /api/comparisons
   * Start a new comparison with uploaded files
   */
  static async create(req: Request, res: Response): Promise<void> {
    let sessionId: string | null = null;
    let companyFilePath: string | null = null;
    let facebookFilePath: string | null = null;

    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const { mode = 'fresh' } = req.body;

      // Get uploaded files
      const companyFile = files?.companyFile?.[0];
      const facebookFile = files?.facebookFile?.[0];
      const { name: sessionNameFromBody, uploadPersonName } = req.body;

      // Validate required files
      if (!companyFile) {
        res.status(400).json({
          success: false,
          message: 'Company CSV file is required'
        });
        return;
      }

      if (!facebookFile) {
        res.status(400).json({
          success: false,
          message: 'Facebook JSON file is required'
        });
        return;
      }

      // Validate session name
      if (!sessionNameFromBody || !sessionNameFromBody.trim()) {
        res.status(400).json({
          success: false,
          message: 'Session name is required'
        });
        return;
      }

      companyFilePath = companyFile.path;
      facebookFilePath = facebookFile.path;

      // Create upload session
      sessionId = crypto.randomUUID();
      const sessionName = sessionNameFromBody.trim();
      
      await UploadSessionModel.create({
        id: sessionId,
        name: sessionName,
        // The uploaded file is deleted immediately after parsing, so don't persist
        // a path that will dangle.
        facebook_file_path: null,
        mode: mode === 'continue' ? 'continue' : 'fresh',
        parent_session_id: null,
        status: 'processing'
      });

      // Notify frontend that processing has started
      WebSocketService.broadcast(sessionId, {
        type: 'processing_started',
        sessionId,
        message: 'File upload complete, starting processing'
      });

      // Parse files
      const companyRecords = await FileParserService.parseCompanyCSV(companyFilePath, sessionId);
      const facebookRecords = await FileParserService.parseFacebookJSON(facebookFilePath, sessionId, uploadPersonName);

      // Merge: drop rows that already exist in the database (and intra-file repeats),
      // keeping the first occurrence. Facebook is keyed on fb_name; company on
      // company_name + person_name_th.
      const newCompanyRecords = await dedupeCompany(companyRecords);
      const newFacebookRecords = await dedupeFacebook(facebookRecords);
      const duplicateRows =
        (companyRecords.length - newCompanyRecords.length) +
        (facebookRecords.length - newFacebookRecords.length);

      // Save only the new rows
      await CompanyDataModel.createMany(newCompanyRecords);
      await FacebookDataModel.createMany(newFacebookRecords);

      // Clean up uploaded files now that parsing is done
      fs.unlinkSync(companyFilePath);
      fs.unlinkSync(facebookFilePath);

      // Automatically forward the merged data to the ingestion webhook. Each page
      // uploads a single real file (the other side is an empty placeholder), so this
      // routes Facebook uploads to FACEBOOK_WEBHOOK_URL and Company uploads to
      // COMPANY_WEBHOOK_URL — never POSTing an empty body. Company sends the full table;
      // Facebook sends only unprocessed (status IS NULL) rows.
      const isCompanyUpload = companyRecords.length > 0;
      const isFacebookUpload = facebookRecords.length > 0;

      const unsentFacebook = isFacebookUpload ? await FacebookDataModel.findUnsent() : [];
      const allCompany = isCompanyUpload ? await CompanyDataModel.findAll() : [];

      const [companyWebhookOk, facebookWebhookOk] = await Promise.all([
        WebhookService.sendCompanyData(allCompany as CompanyDataRecord[]),
        WebhookService.sendFacebookData(unsentFacebook as FacebookDataRecord[])
      ]);

      if (!companyWebhookOk || !facebookWebhookOk) {
        await UploadSessionModel.updateStatus(sessionId, 'failed');
        WebSocketService.broadcast(sessionId, {
          type: 'processing_failed',
          sessionId,
          message: 'Data saved, but sending to the external webhook failed'
        });
        res.status(502).json({
          success: false,
          message: 'Data saved, but sending to the external webhook failed',
          data: {
            sessionId,
            status: 'failed',
            companyRecordsCount: newCompanyRecords.length,
            facebookRecordsCount: newFacebookRecords.length,
            duplicateRows
          }
        });
        return;
      }

      // Forwarded successfully — mark those Facebook rows so re-uploads don't resend them.
      await FacebookDataModel.markSent(unsentFacebook.map((r) => r.uuid));

      // Uploaded and pushed to the ingestion webhook; ready for the Compare trigger.
      await UploadSessionModel.updateStatus(sessionId, 'pending_webhook');

      WebSocketService.broadcast(sessionId, {
        type: 'webhook_success',
        sessionId,
        message: 'Upload done'
      });

      res.status(200).json({
        success: true,
        message: 'Upload merged and sent to webhook successfully',
        data: {
          sessionId,
          name: sessionName,
          mode: mode === 'continue' ? 'continue' : 'fresh',
          status: 'pending_webhook',
          companyRecordsCount: newCompanyRecords.length,
          facebookRecordsCount: newFacebookRecords.length,
          duplicateRows,
          createdAt: new Date().toISOString()
        }
      });
    } catch (error) {
      // Clean up files on error
      if (companyFilePath && fs.existsSync(companyFilePath)) {
        fs.unlinkSync(companyFilePath);
      }
      if (facebookFilePath && fs.existsSync(facebookFilePath)) {
        fs.unlinkSync(facebookFilePath);
      }

      // Update session status to failed if created
      if (sessionId) {
        await UploadSessionModel.updateStatus(sessionId, 'failed');
      }

      console.error('Error creating comparison:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * POST /api/comparisons/:id/merge
   * Merge new files with existing session
   */
  static async merge(req: Request, res: Response): Promise<void> {
    let newSessionId: string | null = null;
    let companyFilePath: string | null = null;
    let facebookFilePath: string | null = null;

    try {
      const { id } = req.params;
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };

      // Get uploaded files
      const companyFile = files?.companyFile?.[0];
      const facebookFile = files?.facebookFile?.[0];
      const { name: sessionNameFromBody, uploadPersonName } = req.body;

      // Check if parent session exists
      const parentSession = await UploadSessionModel.findById(id);
      if (!parentSession) {
        res.status(404).json({
          success: false,
          message: 'Parent session not found'
        });
        return;
      }

      // Validate required files
      if (!companyFile) {
        res.status(400).json({
          success: false,
          message: 'Company CSV file is required'
        });
        return;
      }

      if (!facebookFile) {
        res.status(400).json({
          success: false,
          message: 'Facebook JSON file is required'
        });
        return;
      }

      // Validate session name
      if (!sessionNameFromBody || !sessionNameFromBody.trim()) {
        res.status(400).json({
          success: false,
          message: 'Session name is required'
        });
        return;
      }

      companyFilePath = companyFile.path;
      facebookFilePath = facebookFile.path;

      // Create new merge session with parent reference
      newSessionId = crypto.randomUUID();
      const sessionName = sessionNameFromBody.trim();
      
      await UploadSessionModel.create({
        id: newSessionId,
        name: sessionName,
        // The uploaded file is deleted immediately after parsing, so don't persist
        // a path that will dangle.
        facebook_file_path: null,
        mode: 'continue',
        parent_session_id: id,
        status: 'processing'
      });

      // Notify frontend that merge processing has started
      WebSocketService.broadcast(newSessionId, {
        type: 'processing_started',
        sessionId: newSessionId,
        parentSessionId: id,
        message: 'Merge upload complete, starting processing'
      });

      // Parse files and save to database
      const companyRecords = await FileParserService.parseCompanyCSV(companyFilePath, newSessionId);
      const facebookRecords = await FileParserService.parseFacebookJSON(facebookFilePath, newSessionId, uploadPersonName);

      // Notify frontend about parsed records
      WebSocketService.broadcast(newSessionId, {
        type: 'records_parsed',
        sessionId: newSessionId,
        companyRecordsCount: companyRecords.length,
        facebookRecordsCount: facebookRecords.length
      });

      // Save records to database
      await CompanyDataModel.createMany(companyRecords);
      await FacebookDataModel.createMany(facebookRecords);

      // Update session status to pending_webhook - waiting for manual webhook trigger
      await UploadSessionModel.updateStatus(newSessionId, 'pending_webhook');

      // Notify frontend that data is saved and ready for webhook
      WebSocketService.broadcast(newSessionId, {
        type: 'saved_to_database',
        sessionId: newSessionId,
        message: 'Data saved to database. Ready to send to webhook.'
      });

      // Clean up uploaded files
      fs.unlinkSync(companyFilePath);
      fs.unlinkSync(facebookFilePath);

      res.status(200).json({
        success: true,
        message: 'Merge session created successfully',
        data: {
          sessionId: newSessionId,
          parentSessionId: id,
          name: sessionName,
          mode: 'continue',
          status: 'pending_webhook',
          companyRecordsCount: companyRecords.length,
          facebookRecordsCount: facebookRecords.length,
          createdAt: new Date().toISOString()
        }
      });
    } catch (error) {
      // Clean up files on error
      if (companyFilePath && fs.existsSync(companyFilePath)) {
        fs.unlinkSync(companyFilePath);
      }
      if (facebookFilePath && fs.existsSync(facebookFilePath)) {
        fs.unlinkSync(facebookFilePath);
      }

      // Update session status to failed if created
      if (newSessionId) {
        await UploadSessionModel.updateStatus(newSessionId, 'failed');
      }

      console.error('Error merging comparison:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * POST /api/comparisons/:id/send-webhook
   * Send data to external webhooks for processing
   */
  static async sendWebhook(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Verify session exists
      const session = await UploadSessionModel.findById(id);
      if (!session) {
        res.status(404).json({
          success: false,
          message: 'Session not found'
        });
        return;
      }

      // Check session is in pending_webhook status
      if (session.status !== 'pending_webhook') {
        res.status(400).json({
          success: false,
          message: `Session status is '${session.status}', expected 'pending_webhook'`
        });
        return;
      }

      // Notify frontend that data is being sent to webhooks
      WebSocketService.broadcast(id, {
        type: 'sending_to_webhook',
        sessionId: id,
        message: 'Sending data to external processing service'
      });

      // Get all records for this session
      const companyRecords = await CompanyDataModel.findBySessionId(id);
      const facebookRecords = await FacebookDataModel.findBySessionId(id);

      if (companyRecords.length === 0 && facebookRecords.length === 0) {
        res.status(400).json({
          success: false,
          message: 'No records found for this session'
        });
        return;
      }

      // Send data to webhooks
      const [companyWebhookOk, facebookWebhookOk] = await Promise.all([
        WebhookService.sendCompanyData(companyRecords as CompanyDataRecord[]),
        WebhookService.sendFacebookData(facebookRecords as FacebookDataRecord[])
      ]);

      if (!companyWebhookOk || !facebookWebhookOk) {
        await UploadSessionModel.updateStatus(id, 'failed');
        WebSocketService.broadcast(id, {
          type: 'processing_failed',
          sessionId: id,
          message: 'Failed to send data to external webhooks'
        });
        res.status(502).json({
          success: false,
          message: 'Failed to send data to external webhooks'
        });
        return;
      }

      // Notify frontend that webhooks returned successfully
      WebSocketService.broadcast(id, {
        type: 'webhook_success',
        sessionId: id,
        message: 'Upload done'
      });

      // Update session status - now waiting for callback results
      await UploadSessionModel.updateStatus(id, 'processing');

      // Notify frontend that data was sent and waiting for results
      WebSocketService.broadcast(id, {
        type: 'waiting_for_results',
        sessionId: id,
        message: 'Data sent to external service, waiting for comparison results'
      });

      res.status(200).json({
        success: true,
        message: 'Data sent to webhooks successfully',
        data: {
          sessionId: id,
          status: 'processing',
          companyRecordsCount: companyRecords.length,
          facebookRecordsCount: facebookRecords.length
        }
      });
    } catch (error) {
      console.error('Error sending webhook:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * GET /api/comparisons/:id/company-data
   * Get paginated company data for a session
   */
  static async getCompanyData(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit as string) || 20));

      // Verify session exists
      const session = await UploadSessionModel.findById(id);
      if (!session) {
        res.status(404).json({
          success: false,
          message: 'Session not found'
        });
        return;
      }

      const result = await CompanyDataModel.findBySessionIdPaginated(id, page, limit);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      console.error('Error fetching company data:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * GET /api/comparisons/:id/facebook-data
   * Get paginated facebook data for a session
   */
  static async getFacebookData(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit as string) || 20));

      // Verify session exists
      const session = await UploadSessionModel.findById(id);
      if (!session) {
        res.status(404).json({
          success: false,
          message: 'Session not found'
        });
        return;
      }

      const result = await FacebookDataModel.findBySessionIdPaginated(id, page, limit);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      console.error('Error fetching facebook data:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * GET /api/comparisons/:id/results
   * Get stored comparison (match score) results for a session
   */
  static async getResults(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Verify session exists
      const session = await UploadSessionModel.findById(id);
      if (!session) {
        res.status(404).json({
          success: false,
          message: 'Session not found'
        });
        return;
      }

      const results = await ComparisonResultsModel.findBySessionId(id);

      const scores = results
        .map(r => Number(r.matching_score))
        .filter(s => Number.isFinite(s));
      const meanConfidence = scores.length > 0
        ? scores.reduce((sum, s) => sum + s, 0) / scores.length
        : 0;

      res.status(200).json({
        success: true,
        data: {
          sessionId: id,
          status: session.status,
          rowCount: results.length,
          meanConfidence,
          results
        }
      });
    } catch (error) {
      console.error('Error fetching comparison results:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }
}
