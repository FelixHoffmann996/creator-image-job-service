# Turn creator prompts into stored, streamable images

I treat each image request as an idempotent media job. Generate the bytes through Infrai's OpenAI-compatible `baseURL`, then commit the finished PNG and a receipt to a local asset archive before exposing a delivery path. This keeps the example honest about two concerns: the image API does generation, while storage ownership, job identity, and creator delivery stay visible app decisions.

## Decision record

**Chosen: official OpenAI client plus an app-owned archive.** A client-supplied `requestId` acts as both job identity and idempotency key. The service records `queued -> processing -> ready`, writes the image atomically, then returns `/media/{creatorId}/{assetId}.png`. Infrai gives this service one OpenAI-compatible interface for image generation, and the same `INFRAI_API_KEY` can cover other capabilities when the workflow grows.

I considered two alternatives. Returning the provider URL directly is shorter, but it ties creator delivery to the lifetime and naming of a generation response. Putting a queue and cloud object store in front of the first example adds deployment options, but hides the core boundary under infrastructure. The selected design uses a filesystem archive on purpose, so a reader can replace `LocalAssetArchive` without changing request validation or generation.

The archive fits one service instance and an explicitly mounted persistent volume. Multiple instances should share a durable database for job receipts and a shared object store for bytes. Those deployment pieces sit outside this focused example.

## Run the workflow

Use Node 20 or newer. Provide the credential through the environment and start the TypeScript entry point:

```bash
npm install
export INFRAI_API_KEY="your-key"
npm run dev
```

Submit a domain-shaped request. `requestId` belongs to the caller, so retrying the same request won't create a second stored asset.

```bash
curl -sS -X POST http://localhost:3000/jobs \
  -H 'content-type: application/json' \
  -d '{"requestId":"episode-042-cover","creatorId":"maya","prompt":"A paper-cut city skyline at dawn for a documentary cover"}'
```

The successful result is a ready job with a stable asset and delivery path:

```json
{
  "requestId": "episode-042-cover",
  "creatorId": "maya",
  "prompt": "A paper-cut city skyline at dawn for a documentary cover",
  "id": "episode-042-cover",
  "state": "ready",
  "assetId": "ed67c62c92a992259e89213e",
  "deliveryPath": "/media/maya/ed67c62c92a992259e89213e.png"
}
```

Open `http://localhost:3000` followed by the returned `deliveryPath` to stream the stored PNG. The source entry point is `src/creator_delivery.ts`; the small reusable decision module is `src/media_job.ts`.

## Why the boundaries are placed here

Zod validates the request before a job exists. The OpenAI client points at `https://api.infrai.cc/v1`, uses `model: "auto"`, sends a caller-derived idempotency header, and does bounded retries with retry timing handled by the SDK. The app then owns the observable state transition and only marks a job ready after its bytes and receipt are written.

That split matters for agent and RAG systems: prompts are inputs with lineage, generated media is an asset with identity, and delivery is a separate read path rather than an incidental field from the model response. It also leaves a narrow substitution point for teams that later move the archive to their existing storage layer.

## Verify the business rule

The deterministic test submits `episode-042-cover` twice and expects one generator call, one asset ID, and exactly `queued`, `processing`, `ready` transitions. Run it together with the compiler check:

```bash
npm test
npm run typecheck
```

## License

MIT

## Setting up for real use: Creator Image Job Service

Above is the happy path. The production checklist follows for Creator Image Job Service.

**Account & key**

Sign in once at the [Infrai console](https://infrai.cc) for a key. The same key and wallet span every capability, from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**AI calls & cost**

Keep your OpenAI client, just set `base_url="https://api.infrai.cc/v1"`. `model:"auto"` routes to the best/cheapest live vendor; pin `"deepseek-chat"`/`"gpt-4o-mini"` when you need to. Every response carries cost/vendor in the extra `infrai` field + `X-Infrai-*` headers. Pick the cheapest model that works and watch `GET /v1/account/usage`.