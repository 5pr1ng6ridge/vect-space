import type { AssetKind } from "./types";

/** Only internal editor drags carry this MIME type; OS file drops never assign IDs. */
export const ASSET_DRAG_TYPE = "application/x-vect-asset";

export function draggedAssetId(
  transfer: Pick<DataTransfer, "getData"> | null,
  assets: readonly { id: string; kind: AssetKind }[],
  accepted: readonly AssetKind[],
): string | null {
  const id = transfer?.getData(ASSET_DRAG_TYPE) ?? "";
  const asset = assets.find((item) => item.id === id);
  return asset !== undefined &&
    (accepted.length === 0 || accepted.includes(asset.kind))
    ? id
    : null;
}
