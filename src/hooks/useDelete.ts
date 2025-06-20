/**
 * useDelete.ts
 *
 * Hook for handling email deletion functionality.
 *
 * This hook provides functions to:
 * 1. Start a deletion process for emails from one or more senders.
 * 2. Cancel an ongoing deletion process.
 * 3. Manage the state of the deletion (progress, status, errors).
 * 4. Handle Google authentication checks and prompt for re-authentication if needed.
 * 5. Log deletion actions to local storage and Supabase.
 * 6. Support queue integration for centralized task management.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthProvider';

// --- Contexts & Hooks ---
import {
  useGmailPermissions,
  // TypesTokenStatus // Avoid importing unused types if TokenStatus isn't used directly
} from '@/context/GmailPermissionsProvider'; // Gmail token/permission handling

// --- API/Helper Functions ---
import { estimateRuntimeMs, formatDuration, OperationType, OperationMode } from '@/lib/utils/estimateRuntime';
import { buildQuery, RuleGroup } from '@/lib/gmail/buildQuery';
import { fetchMessageIds } from '@/lib/gmail/fetchMessageIds';
import { batchDeleteMessages } from '@/lib/gmail/batchDeleteMessages'; // Our new helper
import { markSenderActionTaken } from '@/lib/storage/senderAnalysis'; // Import the new function

// --- Storage & Logging ---
import { createActionLog, updateActionLog, completeActionLog } from '@/supabase/actions/logAction';
import {
  createActionLog as createLocalActionLog,
  updateSupabaseLogId,
  updateActionProgress,
  completeActionLog as completeLocalActionLog,
  clearCurrentActionLog,
} from '@/lib/storage/actionLog'; // New imports for action logging

// --- Components ---
import { ReauthDialog } from '@/components/modals/ReauthDialog'; // For prompting re-login

// --- Types ---
import { ActionEndType } from '@/types/actions';
import { DeleteJobPayload, ProgressCallback, ExecutorResult } from '@/types/queue';

// --- Dev Tooling ---
import { logger } from '@/lib/utils/logger';

// --- Constants ---
const TWO_MINUTES_MS = 2 * 60 * 1000; // Threshold for token expiry check before batches
const DELETION_BATCH_SIZE = 1000; // Max IDs for batchDelete
const BATCH_DELAY_MS = 150; // Small delay between batches (optional)

// --- State & Progress Types ---

/** Possible states during the deletion process */
export type DeletingStatus =
  | 'idle' // Not doing anything
  | 'preparing' // Checking permissions, estimating time
  | 'deleting' // Actively calling Gmail API
  | 'completed' // Finished successfully
  | 'error' // Failed with an error
  | 'cancelled'; // User stopped it

/** Detailed progress information for the UI */
export interface DeletingProgress {
  status: DeletingStatus;
  progressPercent: number; // Overall progress (0-100)
  totalEmailsToProcess: number; // Initial estimate
  emailsDeletedSoFar: number; // Running count
  currentSender?: string; // Which sender is being processed now
  error?: string; // Error message if status is 'error'
  eta?: string; // Estimated time remaining (optional)
}

/** Input format: specify sender email and estimated count */
export interface SenderToDelete {
  email: string;
  count: number; // Estimated number of emails from this sender
}

/** Optional filter rules for deletion */
export interface DeleteOptions {
  filterRules?: RuleGroup[]; // Add filter rules as an optional parameter
}

/** State for the re-authentication modal */
interface ReauthModalState {
  isOpen: boolean;
  type: 'expired' | 'will_expire_during_operation'; // will_expire might not be needed now
  eta?: string; // Estimated time for the operation
}

// --- Helper Functions ---
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- The Hook ---

export function useDelete() {
  const { user } = useAuth(); // Get Supabase user session
  const {
    getAccessToken,
    forceRefreshAccessToken,
    peekAccessToken,
    tokenTimeRemaining,
    hasRefreshToken: isGmailConnected, // Alias for clarity
    isClientLoaded
  } = useGmailPermissions(); // Use the new functions from context

  const [progress, setProgress] = useState<DeletingProgress>({
    status: 'idle',
    progressPercent: 0,
    totalEmailsToProcess: 0,
    emailsDeletedSoFar: 0,
  });

  const [reauthModal, setReauthModal] = useState<ReauthModalState>({
    isOpen: false,
    type: 'expired', // Default to expired
  });

  const actionLogIdRef = useRef<string | null>(null);
  const isCancelledRef = useRef<boolean>(false);

  // Add cancellation ref to avoid React closure issues (critical pattern from analysis)
  const cancellationRef = useRef<boolean>(false);
  const progressRef = useRef<DeletingProgress>({
    status: 'idle',
    progressPercent: 0,
    totalEmailsToProcess: 0,
    emailsDeletedSoFar: 0,
  });

  const updateProgress = useCallback(
    (newProgress: Partial<DeletingProgress>) => {
      setProgress((prev) => {
        const updated = { ...prev, ...newProgress };
        progressRef.current = updated; // Keep ref in sync for queue access
        return updated;
      });
    },
    []
  );

  const closeReauthModal = useCallback(() => {
    logger.debug('[Delete] Closing reauth modal');
    setReauthModal((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const cancelDelete = useCallback(async () => {
    logger.debug('[Delete] Cancellation requested');
    isCancelledRef.current = true; // Signal the running process to stop
    cancellationRef.current = true; // Also set the queue-compatible ref
    updateProgress({ status: 'cancelled' }); // Pass partial update object
    setReauthModal({ isOpen: false, type: 'expired' }); // Close modal if open

    const logId = actionLogIdRef.current;
    if (logId) {
      try {
        await completeActionLog(logId, 'user_stopped', progress.emailsDeletedSoFar);
        completeLocalActionLog('user_stopped');
        logger.debug('[Delete] Logged cancellation to Supabase and local storage');
      } catch (error) {
        logger.error('[Delete] Failed to log cancellation:', error);
      } finally {
        actionLogIdRef.current = null; // Clear the ref
      }
    }
  }, [progress.emailsDeletedSoFar, updateProgress]);

  const startDelete = useCallback(
    async (
      senders: SenderToDelete[],
      queueProgressCallback?: ProgressCallback,
      abortSignal?: AbortSignal,
      options?: DeleteOptions
    ): Promise<{ success: boolean }> => {
      logger.debug('[Delete] Starting deletion process for senders:', senders);
      logger.debug('[Delete] With filter rules:', options?.filterRules);
      logger.debug('[Delete] Queue mode:', !!queueProgressCallback);

      // Reset cancellation flags
      isCancelledRef.current = false;
      cancellationRef.current = false;

      updateProgress({ status: 'preparing', progressPercent: 0, emailsDeletedSoFar: 0 });
      logger.debug('[Delete] Preparing deletion...');

      // --- 0. Basic Checks --- (User, Senders, GAPI Client)
      if (!user?.id) {
        toast.error('You must be logged in to delete emails.');
        logger.error('[Delete] User not logged in.');
        updateProgress({ status: 'error', error: 'User not logged in.' });
        return { success: false };
      }
      if (!senders || senders.length === 0) {
        toast.warning('No senders selected for deletion.');
        console.warn('[Delete] No senders provided.');
        updateProgress({ status: 'idle' }); // Go back to idle
        return { success: false };
      }
      if (!isClientLoaded) {
        logger.error('[Delete] Gmail API client is not loaded yet.');
        toast.error('Gmail client not ready', { description: 'Please wait a moment and try again.' });
        updateProgress({ status: 'error', error: 'Gmail client not loaded.' });
        return { success: false };
      }

      // --- 1. Initial Token & Connection Check ---
      if (!isGmailConnected) {
        logger.debug('[Delete] No Gmail connection, showing reauth modal.');
        setReauthModal({ isOpen: true, type: 'expired' });
        updateProgress({ status: 'error', error: 'Gmail not connected.' });
        return { success: false };
      }
      try {
        await getAccessToken(); // Verify refresh token validity and get initial access token
        logger.debug('[Delete] Initial access token validated/acquired.');
      } catch (error) {
        logger.error('[Delete] Failed to validate/acquire initial token:', error);
        setReauthModal({ isOpen: true, type: 'expired' });
        updateProgress({ status: 'error', error: 'Gmail authentication failed.' });
        return { success: false };
      }

      // --- 2. Calculate Estimates ---
      const totalEmailsEstimate = senders.reduce((sum, s) => sum + s.count, 0);
      updateProgress({ totalEmailsToProcess: totalEmailsEstimate });
      logger.debug(`[Delete] Total estimated emails: ${totalEmailsEstimate}`);

      const estimatedRuntimeMs = estimateRuntimeMs({
        operationType: 'delete',
        emailCount: totalEmailsEstimate,
        mode: 'single',
      });
      const formattedEta = formatDuration(estimatedRuntimeMs);
      updateProgress({ eta: formattedEta });
      logger.debug(`[Delete] Estimated runtime: ${formattedEta}`);

      // Initial progress for queue (ensure UI renders properly)
      if (queueProgressCallback) {
        queueProgressCallback(0, totalEmailsEstimate);
      }

      // Add minimum delay for very small operations (UX polish pattern)
      if (totalEmailsEstimate <= 5) {
        await sleep(500);
      }

      // Removed pre-operation token expiry check.
      // Add toast for very long operations (>55 mins)
      if (estimatedRuntimeMs > (55 * 60 * 1000)) {
        toast.warning("Long Deletion Detected", {
          description: `Deleting these emails may take ${formattedEta}. You can navigate away, but ensure this tab stays open. If your session expires, you might need to reconnect.`,
          duration: 8000
        });
      }

      // --- 3. Logging Initialization ---
      const clientActionId = uuidv4();
      createLocalActionLog({
        clientActionId,
        type: 'delete',
        estimatedRuntimeMs,
        totalEmails: totalEmailsEstimate,
        totalEstimatedBatches: Math.ceil(totalEmailsEstimate / DELETION_BATCH_SIZE),
        query: `Deleting from ${senders.length} senders`,
      });
      logger.debug(`[Delete] Created local action log: ${clientActionId}`);

      let supabaseLogId: string | undefined;
      try {
        const actionLog = await createActionLog({
          user_id: user.id,
          type: 'delete',
          status: 'started',
          filters: { senderCount: senders.length, estimatedCount: totalEmailsEstimate },
          estimated_emails: totalEmailsEstimate,
        });
        supabaseLogId = actionLog.id;
        actionLogIdRef.current = supabaseLogId ?? null;
        updateSupabaseLogId(supabaseLogId!); // Update local log with Supabase ID
        logger.debug(`[Delete] Created Supabase action log: ${supabaseLogId}`);
      } catch (error) {
        logger.error('[Delete] Failed to create Supabase action log:', error);
        updateProgress({ status: 'error', error: 'Failed to log action start.' });
        clearCurrentActionLog(); // Clean up local log
        return { success: false };
      }

      // --- 4. Execution Phase ---
      updateProgress({ status: 'deleting', progressPercent: 0 });
      await updateActionLog(supabaseLogId!, { status: 'deleting' });
      logger.debug('[Delete] Starting active deletion...');

      (async () => {
        let totalSuccessfullyDeleted = 0;
        let errorMessage: string | undefined;
        let endType: ActionEndType = 'success'; // Assume success initially
        let currentAccessToken: string;

        try {
          for (const sender of senders) {
            // Check both cancellation sources (critical pattern from analysis)
            if (isCancelledRef.current || cancellationRef.current || abortSignal?.aborted) {
              logger.debug(`[Delete] Cancellation detected before processing ${sender.email}`);
              endType = 'user_stopped';
              break; // Exit the sender loop
            }

            logger.debug(`\n[Delete] Processing sender: ${sender.email} (Est: ${sender.count})`);
            updateProgress({ currentSender: sender.email });

            const query = buildQuery({
              type: 'delete',
              mode: 'single',
              senderEmail: sender.email,
              filterRules: options?.filterRules
            });
            logger.debug(`[Delete] Using query: ${query}`);

            let nextPageToken: string | undefined = undefined;
            let senderDeletedCount = 0;
            let batchFetchAttempts = 0;
            const MAX_FETCH_ATTEMPTS = 30;
            let senderProcessedSuccessfully = true;

            do {
              // Check both cancellation sources (critical pattern from analysis)
              if (isCancelledRef.current || cancellationRef.current || abortSignal?.aborted) {
                logger.debug(`[Delete] Cancellation detected during batch processing for ${sender.email}`);
                endType = 'user_stopped';
                break;
              }

              // --- Token Check & Acquisition before batch ---
              const tokenDetails = peekAccessToken();
              const timeRemaining = tokenTimeRemaining();
              try {
                if (tokenDetails && timeRemaining < TWO_MINUTES_MS) {
                  console.warn(`[Delete] Token expiring soon (in ${formatDuration(timeRemaining)}), forcing refresh...`);
                  currentAccessToken = await forceRefreshAccessToken();
                } else {
                  currentAccessToken = await getAccessToken(); // Gets from memory or refreshes if expired
                }
              } catch (tokenError) {
                logger.error(`[Delete] Token acquisition failed for batch:`, tokenError);
                setReauthModal({ isOpen: true, type: 'expired' });
                throw new Error('Gmail authentication failed during deletion.');
              }
              // ---------------------------------------------

              batchFetchAttempts++;
              logger.debug(`[Delete] Fetching message IDs batch (Attempt ${batchFetchAttempts}) for ${sender.email}...`);

              try {
                const { messageIds, nextPageToken: newPageTokenResult } = await fetchMessageIds(
                    currentAccessToken,
                    query,
                    nextPageToken,
                    DELETION_BATCH_SIZE
                );
                nextPageToken = newPageTokenResult;

                if (messageIds.length === 0) {
                  logger.debug(`[Delete] No more message IDs found for ${sender.email}.`);
                  break;
                }

                logger.debug(`[Delete] Found ${messageIds.length} IDs. Attempting batch delete...`);
                await batchDeleteMessages(currentAccessToken, messageIds);

                senderDeletedCount += messageIds.length;
                totalSuccessfullyDeleted += messageIds.length;
                const overallProgress = totalEmailsEstimate > 0
                  ? Math.min(100, Math.round((totalSuccessfullyDeleted / totalEmailsEstimate) * 100))
                  : (nextPageToken ? 50 : 100);

                logger.debug(`[Delete] Batch successful for ${sender.email}. Total deleted so far: ${totalSuccessfullyDeleted}`);
                updateProgress({
                    emailsDeletedSoFar: totalSuccessfullyDeleted,
                    progressPercent: overallProgress,
                });
                updateActionProgress(batchFetchAttempts, totalSuccessfullyDeleted);

                // Update queue progress callback if provided
                if (queueProgressCallback) {
                  queueProgressCallback(totalSuccessfullyDeleted, totalEmailsEstimate);
                }

                if (BATCH_DELAY_MS > 0 && nextPageToken) {
                    await sleep(BATCH_DELAY_MS);
                }

              } catch (fetchOrDeleteError: any) {
                  logger.error(`[Delete] Error during fetch/delete batch for ${sender.email}:`, fetchOrDeleteError);
                  errorMessage = `Failed during batch operation for ${sender.email}: ${fetchOrDeleteError.message || 'Unknown error'}`;
                  endType = 'runtime_error';
                  toast.error('Deletion error', { description: errorMessage });
                  senderProcessedSuccessfully = false;
                  break;
              }

              if (batchFetchAttempts > MAX_FETCH_ATTEMPTS) {
                  console.warn(`[Delete] Reached max fetch attempts (${MAX_FETCH_ATTEMPTS}) for ${sender.email}. Stopping.`);
                   errorMessage = `Reached maximum processing attempts for ${sender.email}.`;
                   endType = 'runtime_error';
                  break;
              }

            } while (nextPageToken && endType === 'success' && !isCancelledRef.current && !cancellationRef.current && !(abortSignal?.aborted));

            if (senderProcessedSuccessfully && !isCancelledRef.current && !cancellationRef.current && !(abortSignal?.aborted)) {
              try {
                await markSenderActionTaken(sender.email, 'delete');
              } catch (markError) {
                logger.error(`[Delete] Failed to mark action taken for ${sender.email}:`, markError);
              }
            }

            if (endType !== 'success' && endType !== 'user_stopped') {
                break; // Stop processing further senders if an error occurred
            }
          } // End of sender loop

          // --- 5. Finalization ---
          logger.debug(`\n[Delete] Deletion process finished. End type: ${endType}`);
          logger.debug(`[Delete] Total emails successfully deleted: ${totalSuccessfullyDeleted}`);

          await completeActionLog(supabaseLogId!, endType, totalSuccessfullyDeleted, errorMessage);
          completeLocalActionLog(endType, errorMessage);

          updateProgress({
            status: endType === 'success' ? 'completed' : (endType === 'user_stopped' ? 'cancelled' : 'error'),
            progressPercent: endType === 'success' ? 100 : progress.progressPercent,
            emailsDeletedSoFar: totalSuccessfullyDeleted,
            error: errorMessage,
            currentSender: undefined,
          });

          if (endType === 'success') {
            toast.success('Deletion Complete', { description: `Successfully deleted ${totalSuccessfullyDeleted.toLocaleString()} emails from ${senders.length} sender(s).` });
          } else if (endType === 'user_stopped') {
            toast.info('Deletion Cancelled', { description: `Deletion stopped after ${totalSuccessfullyDeleted.toLocaleString()} emails.` });
          } // Errors already toasted

        } catch (processError: any) {
            logger.error('[Delete] Critical error during deletion process:', processError);
            errorMessage = `An unexpected error occurred: ${processError.message || 'Unknown error'}`;
            endType = 'runtime_error';

            if (supabaseLogId) {
                try {
                    await completeActionLog(supabaseLogId, endType, totalSuccessfullyDeleted, errorMessage);
                    completeLocalActionLog(endType, errorMessage);
                } catch (logError) {
                    logger.error("[Delete] Failed to log critical error:", logError);
                }
            }

            updateProgress({ status: 'error', error: errorMessage, currentSender: undefined });
            toast.error('Deletion Failed', { description: errorMessage });
        } finally {
            actionLogIdRef.current = null;
        }
      })();

      return { success: true }; // Indicates process started
    },
    // --- Dependencies ---
    [
      user?.id,
      isClientLoaded,
      isGmailConnected,
      getAccessToken,
      forceRefreshAccessToken,
      peekAccessToken,
      tokenTimeRemaining,
      updateProgress,
      // Removed requestPermissions as errors now trigger modal directly
    ]
  );

  // --- Queue Integration (Wrap Pattern) ---
  const queueExecutor = useCallback(async (
    payload: DeleteJobPayload,
    onProgress: ProgressCallback,
    abortSignal: AbortSignal
  ): Promise<ExecutorResult> => {
    logger.debug('[Delete] Queue executor called with payload:', payload);

    // Convert queue payload to hook format
    const senders: SenderToDelete[] = payload.senders;

    // Set up cancellation handling
    const handleAbort = () => {
      logger.debug('[Delete] Queue abort signal received');
      cancelDelete();
    };
    abortSignal.addEventListener('abort', handleAbort);

    try {
      // Call existing function with progress callback
      const result = await startDelete(senders, onProgress, abortSignal);

      // Wait for completion and determine final result
      return new Promise((resolve) => {
        const checkCompletion = () => {
          const currentProgress = progressRef.current;

          if (currentProgress.status === 'completed') {
            resolve({
              success: true,
              processedCount: currentProgress.emailsDeletedSoFar
            });
          } else if (currentProgress.status === 'cancelled') {
            resolve({
              success: false,
              error: 'Operation cancelled by user',
              processedCount: currentProgress.emailsDeletedSoFar
            });
          } else if (currentProgress.status === 'error') {
            resolve({
              success: false,
              error: currentProgress.error || 'Unknown error occurred',
              processedCount: currentProgress.emailsDeletedSoFar
            });
          } else {
            // Still processing, check again in 1 second
            setTimeout(checkCompletion, 1000);
          }
        };

        // Start checking immediately
        checkCompletion();
      });

    } finally {
      abortSignal.removeEventListener('abort', handleAbort);
    }
  }, [startDelete, cancelDelete]);

  // Register executor with queue system
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).__queueRegisterExecutor) {
      logger.debug('[Delete] Registering queue executor');
      (window as any).__queueRegisterExecutor('delete', queueExecutor);
    }
  }, [queueExecutor]);

  return {
    progress,
    startDelete,
    cancelDelete,
    reauthModal,
    closeReauthModal,
  };
}
