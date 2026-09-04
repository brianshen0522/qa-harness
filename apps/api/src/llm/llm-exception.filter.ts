import { ArgumentsHost, Catch, ExceptionFilter, Logger } from "@nestjs/common";
import type { Response } from "express";
import { LlmExhaustedError } from "./llm-gateway.service";

/**
 * Turns a exhausted fallback chain into a 503 the UI can explain,
 * instead of a generic 500. The attempt log tells the user which
 * config failed and why (spec §4.9).
 */
@Catch(LlmExhaustedError)
export class LlmExceptionFilter implements ExceptionFilter<LlmExhaustedError> {
  private readonly log = new Logger(LlmExceptionFilter.name);

  catch(err: LlmExhaustedError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    this.log.error(`${err.message} :: ${err.attempts.map((a) => `${a.configName}/${a.outcome}`).join(", ")}`);
    res.status(503).json({
      statusCode: 503,
      error: "LLM Unavailable",
      message: err.message,
      attempts: err.attempts.map((a) => ({
        config: a.configName,
        model: a.model,
        attempt: a.attempt,
        outcome: a.outcome,
        errorKind: a.errorKind,
        error: a.error?.slice(0, 300),
      })),
    });
  }
}
