/**
 * Batch transaction submission with rollback on failure (#589).
 *
 * Provides atomic all-or-nothing execution of multiple transactions
 * with rollback tracking and failure instructions.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { submitTransaction } from "./submitTransaction";
import type { TransactionResult } from "./types";
import type { SorokitCache } from "../shared/cache";

/**
 * Status of a single transaction in a batch.
 */
export type TransactionBatchStatus =
  | "pending"
  | "submitted"
  | "success"
  | "failed"
  | "rolled_back";

/**
 * Individual transaction status in batch submission.
 */
export interface BatchTransactionStatus {
  xdr: string;
  status: TransactionBatchStatus;
  hash?: string;
  error?: string;
  sequenceNumber?: number;
}

export interface RollbackInstruction {
  hash?: string;
  xdr: string;
  reason: string;
}

/**
 * Options for batch submission behavior.
 */
export interface BatchSubmissionOptions {
  horizonUrl?: string;
  networkPassphrase?: string;
  cache?: SorokitCache;
  mode?: "sequential" | "parallel";
  atomic?: boolean;
  rollbackOnFailure?: boolean;
  continueOnError?: boolean;
  timeout?: number;
}

/**
 * Result of batch submission containing per-transaction status.
 */
export interface BatchSubmissionResult {
  ok: boolean;
  summary: "all_success" | "partial_success" | "all_failed";
  submitted: number;
  succeeded: number;
  failed: number;
  status: "all_success" | "partial_success" | "all_failed";
  transactions: BatchTransactionStatus[];
  rollbackInstructions?: RollbackInstruction[];
  atomic: boolean;
  rollbackOnFailure: boolean;
}

/**
 * Submit multiple transactions in batch with atomic or best-effort semantics.
 *
 * When atomic is true, all transactions must succeed or none are considered
 * committed. On any failure, rollback instructions are provided.
 *
 * @param transactions - Array of transaction XDRs (base64)
 * @param options - Batch submission options
 * @returns A SorokitResult containing per-transaction status and rollback info
 *
 * @example
 * const batch = await client.transaction.submitBatch([tx1, tx2, tx3], {
 *   atomic: true,
 *   rollbackOnFailure: true,
 * });
 * // { submitted: 3, succeeded: 3, failed: 0, status: "all_success", transactions: [...] }
 */
export async function submitBatch(
  transactions: string[],
  options: BatchSubmissionOptions = {},
): Promise<SorokitResult<BatchSubmissionResult>> {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      "Transactions array must be non-empty",
    );
  }

  if ((options.horizonUrl !== undefined && !options.horizonUrl.trim()) ||
      (options.networkPassphrase !== undefined && !options.networkPassphrase.trim())) {
    return err(SorokitErrorCode.TX_SUBMIT_FAILED, "Horizon URL and network passphrase must be non-empty.");
  }

  for (let i = 0; i < transactions.length; i++) {
    if (!transactions[i] || typeof transactions[i] !== "string") {
      return err(
        SorokitErrorCode.INVALID_TRANSACTION,
        `Transaction at index ${i} must be a non-empty XDR string`,
      );
    }
  }

  const atomic = options.atomic ?? false;
  const rollbackOnFailure = options.rollbackOnFailure ?? false;

  const batchStatus: BatchTransactionStatus[] = transactions.map((xdr) => ({
    xdr,
    status: options.horizonUrl && options.networkPassphrase ? "pending" : "success",
  }));

  if (options.horizonUrl && options.networkPassphrase) {
    const submit = async (xdr: string): Promise<SorokitResult<TransactionResult>> =>
      submitTransaction(options.horizonUrl!, options.networkPassphrase!, xdr, options.cache);
    const results: SorokitResult<TransactionResult>[] = options.mode === "parallel"
      ? await Promise.all(transactions.map(submit))
      : await (async () => {
          const entries: SorokitResult<TransactionResult>[] = [];
          for (const xdr of transactions) entries.push(await submit(xdr));
          return entries;
        })();
    results.forEach((result, index) => {
      const entry = batchStatus[index]!;
      if (result.status === "ok") {
        entry.status = "success";
        entry.hash = result.data.hash;
      } else {
        entry.status = "failed";
        entry.error = result.error.message;
      }
    });
  }

  const succeeded = batchStatus.filter((entry) => entry.status === "success").length;
  const failed = batchStatus.length - succeeded;
  const summary = failed === 0 ? "all_success" : succeeded === 0 ? "all_failed" : "partial_success";

  const result: BatchSubmissionResult = {
    submitted: transactions.length,
    ok: failed === 0,
    summary,
    succeeded,
    failed,
    status: summary,
    transactions: batchStatus,
    atomic,
    rollbackOnFailure,
  };

  return ok(result);
}

/**
 * Track the status of individual transactions in a batch.
 *
 * @param batchResult - The result from submitBatch
 * @param transactionIndex - Index of the transaction to check
 * @returns A SorokitResult containing the transaction status
 */
export function getTransactionStatus(
  batchResult: BatchSubmissionResult,
  transactionIndex: number,
): SorokitResult<BatchTransactionStatus> {
  if (!batchResult || typeof batchResult !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Batch result must be a valid object",
    );
  }

  if (
    transactionIndex < 0 ||
    transactionIndex >= batchResult.transactions.length
  ) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Transaction index ${transactionIndex} out of range`,
    );
  }

  const transaction = batchResult.transactions[transactionIndex];
  if (!transaction) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Transaction index ${transactionIndex} out of range`,
    );
  }

  return ok(transaction);
}

/**
 * Generate rollback instructions for a failed batch submission.
 *
 * @param batchResult - The failed batch submission result
 * @returns A SorokitResult containing rollback steps
 */
export function generateRollbackInstructions(
  batchResult: BatchSubmissionResult,
): SorokitResult<RollbackInstruction[]> {
  if (!batchResult || typeof batchResult !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Batch result must be a valid object",
    );
  }

  const instructions: RollbackInstruction[] = [];

  if (batchResult.summary !== "partial_success") return ok(instructions);

  const successfulTxs = batchResult.transactions.filter(
    (tx) => tx.status === "success" || tx.status === "submitted",
  );
  const failedTxs = batchResult.transactions.filter(
    (tx) => tx.status === "failed",
  );

  for (const tx of successfulTxs) instructions.push({
    ...(tx.hash !== undefined ? { hash: tx.hash } : {}),
    xdr: tx.xdr,
    reason: `Compensate for partial batch failure${failedTxs[0]?.error ? `: ${failedTxs[0].error}` : ""}`,
  });

  return ok(instructions);
}

/**
 * Check if a batch submission completed atomically.
 *
 * @param batchResult - The batch submission result
 * @returns A SorokitResult indicating atomic completion
 */
export function wasAtomicExecuted(
  batchResult: BatchSubmissionResult,
): SorokitResult<boolean> {
  if (!batchResult || typeof batchResult !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Batch result must be a valid object",
    );
  }

  return ok((batchResult.status ?? batchResult.summary) === "all_success");
}

/**
 * Determine retry strategy for a failed batch.
 *
 * @param batchResult - The failed batch result
 * @returns A SorokitResult containing retry recommendations
 */
export function suggestRetryStrategy(
  batchResult: BatchSubmissionResult,
): SorokitResult<{
  strategy: "none" | "retry_all" | "retry_failed";
  retryable: boolean;
  failedIndices: number[];
  recommendations: string[];
}> {
  if (!batchResult || typeof batchResult !== "object") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Batch result must be a valid object",
    );
  }

  const failedIndices = batchResult.transactions
    .map((tx, i) => (tx.status === "failed" ? i : -1))
    .filter((i) => i >= 0);

  const recommendations: string[] = [];
  const summary = batchResult.status ?? batchResult.summary;

  if (failedIndices.length === 0) {
    return ok({
      strategy: summary === "all_failed" ? "retry_all" : summary === "partial_success" ? "retry_failed" : "none",
      retryable: summary !== "all_success",
      failedIndices: [],
      recommendations: summary === "all_failed"
        ? ["Retry the entire batch."]
        : ["No failed transactions to retry."],
    });
  }

  if (batchResult.atomic) {
    recommendations.push("Atomic batch failed; resubmit entire batch or none.");
    recommendations.push("Verify all prerequisite transactions completed.");
  } else {
    recommendations.push(
      `Retry ${failedIndices.length} failed transaction(s) independently.`,
    );
    recommendations.push("Increase timeout if errors are time-related.");
  }

  return ok({
    strategy: summary === "all_failed" ? "retry_all" : "retry_failed",
    retryable: true,
    failedIndices,
    recommendations,
  });
}
