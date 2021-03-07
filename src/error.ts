import { BaseError } from 'make-error';
import Apify from 'apify';

/**
 * Contains information about the error
 */
export interface InfoErrorMeta<T = any> {
    /**
     * Url that had the error
     */
    url: string;
    /**
     * Differentiate between error causes, usually the name of the function / section
     */
    namespace: string;
    /**
     * Failing CSS selector
     */
     selector?: string;
    /**
     * Attach request userData to the error
     */
    userData?: T;
}

/**
 * Enriched error with contextual information
 */
export class InfoError<T = any> extends BaseError {
    time: string;

    meta: InfoErrorMeta<T>;

    runId: string | null;

    constructor(message: string, meta: InfoErrorMeta<T>) {
        super(message);

        this.time = new Date().toISOString();
        this.meta = {
            ...meta,
        };
        this.runId = Apify.getEnv().actorRunId;
    }

    toJSON() {
        return {
            runId: this.runId,
            time: this.time,
            meta: this.meta,
        };
    }
}
