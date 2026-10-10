import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalAssetArchive, MediaJobRunner, type JobState } from "../src/media_job.js";

test("a retried creator request reuses one generated asset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "media-job-"));
  const states: JobState[] = [];
  let generations = 0;
  const generator = {
    async generate(): Promise<Buffer> {
      generations += 1;
      return Buffer.from("deterministic-png-bytes");
    },
  };
  const runner = new MediaJobRunner(
    generator,
    new LocalAssetArchive(root),
    (job) => states.push(job.state),
  );
  const request = {
    requestId: "episode-042-cover",
    creatorId: "maya",
    prompt: "A paper-cut city skyline for episode forty-two",
  };

  try {
    const [first, concurrentRetry] = await Promise.all([runner.run(request), runner.run(request)]);
    const retried = await runner.run(request);

    assert.equal(first.state, "ready");
    assert.equal(concurrentRetry.assetId, first.assetId);
    assert.equal(retried.assetId, first.assetId);
    assert.equal(generations, 1);
    assert.deepEqual(states, ["queued", "processing", "ready"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
