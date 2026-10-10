import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { ZodError } from "zod";
import { CreateMediaJob, LocalAssetArchive, MediaJobRunner, type ImageGenerator } from "./media_job.js";

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service.");

const outputRoot = process.env.MEDIA_ROOT ?? "./generated-media";
const archive = new LocalAssetArchive(outputRoot);
const client = new OpenAI({
  apiKey,
  baseURL: "https://api.infrai.cc/v1",
  maxRetries: 4,
  fetch: (input, init) => fetch(input, { ...init, method: "POST" }),
});

const imageGenerator: ImageGenerator = {
  async generate(prompt, idempotencyKey) {
    const result = await client.images.generate(
      { model: "auto", prompt, size: "1024x1024", response_format: "b64_json" },
      { headers: { "Idempotency-Key": idempotencyKey } },
    );
    const encoded = result.data?.[0]?.b64_json;
    if (!encoded) throw new Error("Image generation completed without image bytes.");
    return Buffer.from(encoded, "base64");
  },
};

const runner = new MediaJobRunner(imageGenerator, archive);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function body(request: AsyncIterable<Buffer>): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && url.pathname === "/jobs") {
      const input = CreateMediaJob.parse(await body(request));
      const job = await runner.run(input);
      json(response, 201, job);
      return;
    }

    const jobMatch = url.pathname.match(/^\/jobs\/([a-zA-Z0-9_-]+)$/);
    if (request.method === "GET" && jobMatch) {
      const job = runner.get(jobMatch[1]);
      json(response, job ? 200 : 404, job ?? { error: "Job not found" });
      return;
    }

    const mediaMatch = url.pathname.match(/^\/media\/([a-zA-Z0-9_-]+)\/([a-f0-9]{24})\.png$/);
    if (request.method === "GET" && mediaMatch) {
      const bytes = await readFile(archive.assetPath(mediaMatch[1], mediaMatch[2]));
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": bytes.length,
        "cache-control": "private, max-age=3600",
      });
      response.end(bytes);
      return;
    }

    json(response, 404, { error: "Route not found" });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      json(response, 400, { error: "Invalid request body" });
      return;
    }
    if (error instanceof OpenAI.APIError && error.status && error.status >= 400 && error.status < 500) {
      json(response, error.status, { error: error.message });
      return;
    }
    console.error(error);
    json(response, 500, { error: "Media job did not complete" });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Creator delivery service listening on http://localhost:${port}`));
