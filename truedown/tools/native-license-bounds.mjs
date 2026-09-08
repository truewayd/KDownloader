export const MAX_LICENSE_BYTES = 1 << 20;
export const MAX_INVENTORY_BYTES = 4 << 20;

export async function readBoundedLicenseResponse(response, limit = MAX_LICENSE_BYTES) {
  const tooLarge = () => new Error("Pinned license source exceeded its size limit");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const data = Buffer.allocUnsafe(limit);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) throw tooLarge();
      data.set(value, size);
      size += value.byteLength;
    }
    return Buffer.from(data.subarray(0, size));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function licenseInventory(limit = MAX_INVENTORY_BYTES) {
  const lines = [];
  let size = 0;
  return {
    push(...next) {
      const added = next.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
      if (size + added > limit) throw new Error("Native license inventory exceeds its package limit");
      lines.push(...next);
      size += added;
    },
    text: () => lines.join("\n") + "\n",
  };
}
