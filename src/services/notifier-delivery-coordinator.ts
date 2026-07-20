import type {
    TPSNotifierConsumerDeliveryResult,
} from "../tps-notifier-contract";
import {
    NotifierDeliveryLedger,
    type NotifierDeliveryAttemptClaim,
    type NotifierDeliveryAttemptOptions,
} from "./notifier-delivery-ledger";

type UnclaimedNotifierDeliveryAttempt = Extract<NotifierDeliveryAttemptClaim, { claimed: false }>;

export interface NotifierDeliverySender<TFile = unknown> {
    send(request: Readonly<{ title?: string; body: string; file?: TFile }>): Promise<TPSNotifierConsumerDeliveryResult>;
}

export interface NotifierDeliveryOutcome {
    readonly result: TPSNotifierConsumerDeliveryResult;
    readonly persisted: boolean;
    readonly sendInvoked: boolean;
    readonly reusedExisting: boolean;
    readonly ledgerReason?: UnclaimedNotifierDeliveryAttempt["reason"] | "settlement-failed";
}

const NOT_ATTEMPTED_INTERRUPTED_RESULT: TPSNotifierConsumerDeliveryResult = Object.freeze({
    state: "not-attempted",
    transport: "unavailable",
    evidence: "interrupted",
    attempted: false,
});

const UNKNOWN_INTERRUPTED_RESULT: TPSNotifierConsumerDeliveryResult = Object.freeze({
    state: "unknown",
    transport: "unknown",
    evidence: "interrupted",
    attempted: "unknown",
});

const INVALID_LEDGER_RESULT: TPSNotifierConsumerDeliveryResult = Object.freeze({
    state: "unknown",
    transport: "unknown",
    evidence: "invalid-record",
    attempted: "unknown",
});

/**
 * Coordinates one durable delivery attempt. The attempting record is persisted
 * before the sender is invoked, and every sender result is terminal for the
 * supplied occurrence key. This class never chooses or invokes an alternate transport.
 */
export class NotifierDeliveryCoordinator<TFile = unknown> {
    constructor(
        private readonly sender: NotifierDeliverySender<TFile>,
        private readonly ledger: NotifierDeliveryLedger,
    ) {}

    async deliver(
        key: string,
        request: Readonly<{ title?: string; body: string; file?: TFile }>,
        options: Readonly<NotifierDeliveryAttemptOptions> = {},
    ): Promise<NotifierDeliveryOutcome> {
        const claim = this.ledger.beginAttempt(key, options);
        if (claim.claimed === false) return this.outcomeForUnclaimedAttempt(claim);

        let result: TPSNotifierConsumerDeliveryResult;
        try {
            result = await this.sender.send(request);
        } catch {
            result = UNKNOWN_INTERRUPTED_RESULT;
        }

        const settlement = this.ledger.settleAttempt(key, claim.attemptId, result);
        if (!settlement.settled) {
            return {
                result: UNKNOWN_INTERRUPTED_RESULT,
                persisted: false,
                sendInvoked: true,
                reusedExisting: false,
                ledgerReason: "settlement-failed",
            };
        }

        return {
            result,
            persisted: true,
            sendInvoked: true,
            reusedExisting: false,
        };
    }

    private outcomeForUnclaimedAttempt(claim: UnclaimedNotifierDeliveryAttempt): NotifierDeliveryOutcome {
        if (claim.reason === "existing-record" && claim.existingRecord) {
            const persistedResult = this.ledger.resultForRecord(claim.existingRecord);
            return {
                result: persistedResult ?? UNKNOWN_INTERRUPTED_RESULT,
                persisted: true,
                sendInvoked: false,
                reusedExisting: true,
                ledgerReason: claim.reason,
            };
        }

        const invalidLedger = claim.reason === "blocked"
            && this.ledger.blockReason !== "not-loaded"
            && this.ledger.blockReason !== "storage-read-failed"
            && this.ledger.blockReason !== "storage-write-failed";
        return {
            result: invalidLedger ? INVALID_LEDGER_RESULT : NOT_ATTEMPTED_INTERRUPTED_RESULT,
            persisted: false,
            sendInvoked: false,
            reusedExisting: false,
            ledgerReason: claim.reason,
        };
    }
}
