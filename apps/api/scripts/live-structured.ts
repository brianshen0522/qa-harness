import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { LlmGatewayService, LlmExhaustedError } from "../src/llm/llm-gateway.service";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["warn", "error"] });
  const gw = app.get(LlmGatewayService);
  try {
    const r = await gw.structured("generate", "feature_list", {
      system: "You are a QA analyst.",
      messages: [{ role: "user", content: "Product: a todo app with login, list, add, complete and delete tasks. List its features." }],
      maxTokens: 512, temperature: 0,
    }, { maxRetries: 2 });
    console.log("RESULT", JSON.stringify({ model: r.model, fallbacks: r.fallbacks, attempts: r.attempts.map((a: { outcome: string }) => a.outcome), features: r.data.features.length }));
    console.log(JSON.stringify(r.data, null, 1).slice(0, 600));
  } catch (e) {
    if (e instanceof LlmExhaustedError) console.log("EXHAUSTED", JSON.stringify(e.attempts.map((a: { outcome: string; error?: string }) => ({ o: a.outcome, e: a.error?.slice(0, 120) })), null, 1));
    else throw e;
  }
  await app.close();
}
main();
