import assert from "node:assert/strict";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { parseS3ObjectSpec, S3Store } from "../src/storage";

test("S3 object specs accept canonical, documented, and URI forms", () => {
  assert.deepEqual(parseS3ObjectSpec("s3:bucket:inputs/file.json"), { bucket: "bucket", key: "inputs/file.json" });
  assert.deepEqual(parseS3ObjectSpec("s3:bucket/inputs/file.json"), { bucket: "bucket", key: "inputs/file.json" });
  assert.deepEqual(parseS3ObjectSpec("s3://bucket/inputs/file.json"), { bucket: "bucket", key: "inputs/file.json" });
  assert.throws(() => parseS3ObjectSpec("s3:bucket"), /bucket and key/);
});

test("S3 promotion preserves the quoted R2 ETag in If-Match serialization", async () => {
  const headStore = new S3Store("bucket", "", {
    async send() {
      return { ETag: '"29d9opaque"', ContentLength: 1, Metadata: { sha256: "a".repeat(64) } };
    },
  } as never);
  const head = await headStore.head("current.json");
  assert.equal(head?.etag, '"29d9opaque"');

  const requests: Array<{ headers: Record<string, string> }> = [];
  const client = new S3Client({
    region: "auto",
    endpoint: "https://056c5ee24d776cdb856a8a8dea30ed34.r2.cloudflarestorage.com",
    credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
    requestHandler: {
      async handle(request: { headers: Record<string, string> }) {
        requests.push(request);
        return { response: { statusCode: 200, headers: {}, body: new Uint8Array() } };
      },
    } as never,
  });
  const store = new S3Store("bucket", "", client);
  await store.writeConditional("current.json", new Uint8Array([1]), "application/json", { ifMatch: head?.etag });
  assert.equal(requests[0]?.headers["if-match"], '"29d9opaque"');
});
