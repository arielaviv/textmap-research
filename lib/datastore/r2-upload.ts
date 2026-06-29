/**
 * Read-only R2 (S3-compatible) object reader for textmap-research.
 *
 * The repr-eval real-OSM scenes load pre-indexed OpenStreetMap city extracts
 * (`osm/buildings/{city}.json`, `osm/streets/{city}.json`) that live in Nexma's
 * Cloudflare R2 bucket. This mirrors the product's R2 access (same `AWS_*` creds
 * + `LAKEHOUSE_BUCKET`) but only the GET path the eval needs.
 *
 * Resolution order for `getObjectText`:
 *   1. If R2 is configured (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` +
 *      `AWS_ENDPOINT_URL`), read the object directly from the bucket.
 *   2. Else if `OSM_DATA_BASE_URL` is set, fetch `{base}/{key}` over HTTP.
 *   3. Else throw — callers (the OSM services) catch and degrade to synthetic
 *      scenes.
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

const BUCKET = process.env.LAKEHOUSE_BUCKET ?? "nexma-lakehouse";
const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "";
const SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "";
const ENDPOINT_URL = process.env.AWS_ENDPOINT_URL ?? "";
const REGION = process.env.AWS_REGION ?? "auto";

function r2Configured(): boolean {
  return Boolean(ACCESS_KEY_ID && SECRET_ACCESS_KEY && ENDPOINT_URL);
}

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: REGION === "auto" ? "us-east-1" : REGION, // SDK needs a real region; R2 ignores it
      endpoint: ENDPOINT_URL,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    });
  }
  return client;
}

export async function getObjectText(key: string): Promise<string> {
  if (r2Configured()) {
    const res = await getClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!res.Body) throw new Error(`empty R2 object: ${key}`);
    return (res.Body as { transformToString(): Promise<string> }).transformToString();
  }

  const base = process.env.OSM_DATA_BASE_URL;
  if (base) {
    const url = `${base.replace(/\/$/, "")}/${key}`;
    const fetchRes = await fetch(url);
    if (!fetchRes.ok) {
      throw new Error(`[r2-upload] Failed to fetch ${url}: ${fetchRes.status}`);
    }
    return fetchRes.text();
  }

  throw new Error(
    `[r2-upload] No R2 credentials and no OSM_DATA_BASE_URL configured; cannot load "${key}". ` +
      "Pre-indexed OSM data is unavailable — real-OSM scenes will fall back to synthetic.",
  );
}
