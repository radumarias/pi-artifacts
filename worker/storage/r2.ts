/** Delete every object under `prefix` (but those under `keep`), a page of the listing at a time. */
export async function deletePrefix(bucket: R2Bucket, prefix: string, keep?: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    const keys: string[] = page.objects.map((object: R2Object) => object.key).filter((key: string) => !keep || !key.startsWith(keep));
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
