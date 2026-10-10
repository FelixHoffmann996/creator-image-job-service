import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const CreateMediaJob = z.object({
  requestId: z.string().min(8).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  creatorId: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  prompt: z.string().min(10).max(2000),
});

export type CreateMediaJob = z.infer<typeof CreateMediaJob>;
export type JobState = "queued" | "processing" | "ready";

export type MediaJob = CreateMediaJob & {
  id: string;
  state: JobState;
  assetId?: string;
  deliveryPath?: string;
};

export interface ImageGenerator {
  generate(prompt: string, idempotencyKey: string): Promise<Buffer>;
}

type StoredReceipt = {
  jobId: string;
  assetId: string;
  creatorId: string;
  prompt: string;
  deliveryPath: string;
};

export class LocalAssetArchive {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async find(requestId: string): Promise<StoredReceipt | undefined> {
    try {
      return JSON.parse(await readFile(this.receiptPath(requestId), "utf8")) as StoredReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async store(input: CreateMediaJob, bytes: Buffer): Promise<StoredReceipt> {
    const assetId = createHash("sha256")
      .update(`${input.creatorId}\0${input.requestId}`)
      .digest("hex")
      .slice(0, 24);
    const creatorDir = path.join(this.root, input.creatorId);
    const assetPath = path.join(creatorDir, `${assetId}.png`);
    const receipt: StoredReceipt = {
      jobId: input.requestId,
      assetId,
      creatorId: input.creatorId,
      prompt: input.prompt,
      deliveryPath: `/media/${input.creatorId}/${assetId}.png`,
    };

    await mkdir(creatorDir, { recursive: true });
    const temporary = `${assetPath}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, assetPath);
    await writeFile(this.receiptPath(input.requestId), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    return receipt;
  }

  assetPath(creatorId: string, assetId: string): string {
    return path.join(this.root, creatorId, `${assetId}.png`);
  }

  private receiptPath(requestId: string): string {
    return path.join(this.root, `${requestId}.json`);
  }
}

export class MediaJobRunner {
  private readonly jobs = new Map<string, MediaJob>();
  private readonly inFlight = new Map<string, Promise<MediaJob>>();
  private readonly generator: ImageGenerator;
  private readonly archive: LocalAssetArchive;
  private readonly observe: (job: MediaJob) => void;

  constructor(
    generator: ImageGenerator,
    archive: LocalAssetArchive,
    observe: (job: MediaJob) => void = () => undefined,
  ) {
    this.generator = generator;
    this.archive = archive;
    this.observe = observe;
  }

  async run(input: CreateMediaJob): Promise<MediaJob> {
    const active = this.jobs.get(input.requestId);
    if (active?.state === "ready") return active;
    const pending = this.inFlight.get(input.requestId);
    if (pending) return pending;

    const work = this.process(input).finally(() => this.inFlight.delete(input.requestId));
    this.inFlight.set(input.requestId, work);
    return work;
  }

  private async process(input: CreateMediaJob): Promise<MediaJob> {
    const stored = await this.archive.find(input.requestId);
    if (stored) {
      const ready = this.readyJob(input, stored);
      this.jobs.set(input.requestId, ready);
      return ready;
    }

    const queued: MediaJob = { ...input, id: input.requestId, state: "queued" };
    this.transition(queued);
    this.transition({ ...queued, state: "processing" });

    const bytes = await this.generator.generate(input.prompt, input.requestId);
    const receipt = await this.archive.store(input, bytes);
    const ready = this.readyJob(input, receipt);
    this.transition(ready);
    return ready;
  }

  get(id: string): MediaJob | undefined {
    return this.jobs.get(id);
  }

  private readyJob(input: CreateMediaJob, receipt: StoredReceipt): MediaJob {
    return {
      ...input,
      id: receipt.jobId,
      state: "ready",
      assetId: receipt.assetId,
      deliveryPath: receipt.deliveryPath,
    };
  }

  private transition(job: MediaJob): void {
    this.jobs.set(job.id, job);
    this.observe(job);
  }
}
