import { Request, Response } from 'express';
import { ComparisonResultsModel } from '../models/comparison-results.model';
import { UploadSessionModel } from '../models/upload-session.model';
import { WebSocketService } from '../services/websocket.service';

interface ComparisonResultItem {
  fb_name: string;
  person_name_en: string;
  person_name_th: string;
  matching_score: number;
}

interface CallbackPayload {
  session_id: string;
  batch_number: number;
  total_batches: number;
  results: ComparisonResultItem[];
  is_complete: boolean;
}

export class CallbacksController {
  /**
   * POST /api/callbacks/comparison-results
   * Receive batch results from external workflow
   */
  static async receiveComparisonResults(req: Request, res: Response): Promise<void> {
    try {
      const payload: CallbackPayload = req.body;

      // Validate required fields
      if (!payload.session_id || typeof payload.batch_number !== 'number') {
        res.status(400).json({
          success: false,
          message: 'Missing required fields: session_id, batch_number'
        });
        return;
      }

      if (!Array.isArray(payload.results)) {
        res.status(400).json({
          success: false,
          message: 'results must be an array'
        });
        return;
      }

      // Verify session exists
      const session = await UploadSessionModel.findById(payload.session_id);
      if (!session) {
        res.status(404).json({
          success: false,
          message: 'Session not found'
        });
        return;
      }

      // Store results in database
      if (payload.results.length > 0) {
        const records = payload.results.map(item => ({
          fb_name: item.fb_name,
          person_name_en: item.person_name_en,
          person_name_th: item.person_name_th,
          matching_score: item.matching_score,
          batch_number: payload.batch_number,
          is_complete: payload.is_complete ?? false,
          session_id: payload.session_id
        }));

        await ComparisonResultsModel.createMany(records);
      }

      // Update batch tracking
      await ComparisonResultsModel.updateBatchStatus(
        payload.session_id,
        payload.batch_number,
        payload.total_batches || payload.batch_number,
        payload.is_complete ?? false
      );

      // Check if all batches received. total_batches === 0 means the total is not
      // yet known, so it must not be treated as "complete".
      const batchStatus = await ComparisonResultsModel.getBatchStatus(payload.session_id);
      const allBatchesComplete =
        batchStatus.total_batches > 0 &&
        batchStatus.received_batches >= batchStatus.total_batches;

      // Send real-time update via WebSocket
      WebSocketService.broadcast(payload.session_id, {
        type: 'batch_received',
        sessionId: payload.session_id,
        batchNumber: payload.batch_number,
        totalBatches: payload.total_batches,
        recordsCount: payload.results.length,
        isComplete: payload.is_complete,
        progress: batchStatus.total_batches > 0 
          ? Math.round((batchStatus.received_batches / batchStatus.total_batches) * 100)
          : 0
      });

      // If all batches received, update session status. batchStatus.total_records is
      // counted after this batch was inserted, so it already includes these results —
      // do not add payload.results.length again.
      if (allBatchesComplete || payload.is_complete) {
        await UploadSessionModel.updateStatus(payload.session_id, 'completed');
        ComparisonResultsModel.clearBatchTracking(payload.session_id);

        WebSocketService.broadcast(payload.session_id, {
          type: 'comparison_complete',
          sessionId: payload.session_id,
          totalRecords: batchStatus.total_records
        });
      }

      res.status(200).json({
        success: true,
        message: 'Results received successfully',
        data: {
          sessionId: payload.session_id,
          batchNumber: payload.batch_number,
          recordsStored: payload.results.length,
          allBatchesComplete
        }
      });
    } catch (error) {
      console.error('Error receiving comparison results:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }
}
