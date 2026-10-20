/**
 * Time-locked transaction scheduling and execution (#587).
 *
 * Provides time-lock support for scheduling transactions to execute at
 * specific future times using Stellar time bounds (ledger close time).
 */

import {
  Account,
  BASE_FEE,
  Horizon,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";

/**
 * Inclusive time bounds for a Stellar transaction.
 * Both fields are Unix timestamps in seconds.
 */
export interface TimeBounds {
  /** Earliest time the transaction is valid (Unix seconds). 0 means no lower bound. */
  minTime: number;
  /** Latest time the transaction is valid (Unix seconds). 0 means no upper bound. */
  maxTime: number;
}

/** Status of a time-locked transaction evaluated against a timestamp. */
export type TimeLockExecutionStatus =
  | "pending"
  | "executable"
  | "expired"
  | "invalid";

/** Options for building a time-locked transaction. */
export interface TimeLockTransactionOptions {
  timeBounds: TimeBounds;
  /** Current on-chain sequence; when omitted it is loaded from Horizon. */
  sequence?: string;
  /** Override the transaction fee in stroops. Defaults to BASE_FEE. */
  fee?: string;
}

function isValidTimeBounds(timeBounds: TimeBounds): boolean {
  if (
    !timeBounds ||
    typeof timeBounds !== "object" ||
    !Number.isFinite(timeBounds.minTime) ||
    !Number.isFinite(timeBounds.maxTime) ||
    timeBounds.minTime < 0 ||
    timeBounds.maxTime < 0
  ) {
    return false;
  }
  return timeBounds.maxTime === 0 || timeBounds.minTime <= timeBounds.maxTime;
}

/**
 * Validate that a TimeBounds object is logically consistent.
 *
 * @returns `true` when bounds are finite, non-negative and ordered.
 */
export function validateTimeBounds(timeBounds: TimeBounds): boolean {
  return isValidTimeBounds(timeBounds);
}

/**
 * Evaluate the execution status of a time-locked transaction at a given moment.
 */
export function getTimeLockedTransactionStatus(
  timeBounds: TimeBounds,
  nowSeconds?: number,
): TimeLockExecutionStatus {
  if (!isValidTimeBounds(timeBounds)) return "invalid";

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(now)) return "invalid";
  if (timeBounds.minTime > 0 && now < timeBounds.minTime) return "pending";
  if (timeBounds.maxTime !== 0 && now > timeBounds.maxTime) return "expired";
  return "executable";
}

/**
 * Build an unsigned time-locked transaction XDR.
 *
 * The source account sequence is loaded from Horizon unless supplied in
 * options. The transaction uses a bump-sequence operation and Stellar
 * timebounds. Since Stellar encodes a zero max time as no upper bound, a
 * safety deadline is added when only a minimum time is requested.
 */
export async function buildTimeLockTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  options: TimeLockTransactionOptions,
): Promise<SorokitResult<string>> {
  const timeBounds = options?.timeBounds;
  if (!isValidTimeBounds(timeBounds)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Invalid time bounds: values must be finite, non-negative, and ordered.",
    );
  }

  try {
    let account: Account;
    if (options.sequence !== undefined) {
      account = new Account(sourcePublicKey, options.sequence);
    } else {
      const server = new Horizon.Server(horizonUrl);
      const loaded = await server.loadAccount(sourcePublicKey);
      account = new Account(sourcePublicKey, loaded.sequenceNumber());
    }

    let builder = new TransactionBuilder(account, {
      fee: options.fee ?? BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    }).addOperation(
      Operation.bumpSequence({ bumpTo: account.sequenceNumber() }),
    );

    if (timeBounds.maxTime !== 0) {
      builder = builder.setTimebounds(timeBounds.minTime, timeBounds.maxTime);
    } else if (timeBounds.minTime !== 0) {
      builder = builder.setTimebounds(
        timeBounds.minTime,
        Math.floor(Date.now() / 1000) + DEFAULT_TX_TIMEOUT_SECONDS,
      );
    } else {
      builder = builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);
    }

    return ok(builder.build().toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build time-lock transaction: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}
