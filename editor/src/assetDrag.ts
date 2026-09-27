import { isAssetHidden } from "./assetLibrary";
import type { AssetKind, EditorAsset, EditorLayout } from "./types";

/** Only internal editor drags carry this MIME type; OS file drops never assign IDs. */
export const ASSET_DRAG_TYPE = "application/x-vect-asset";

/**
 * Extra payload a multi-selection drag from the asset library adds.
 *
 * A stage drop accepts exactly one authored id, so a drag that carries a
 * selection is refused instead of silently applying its first entry.
 */
export const ASSET_MULTI_DRAG_TYPE = "application/x-vect-assets";

/** The MIME type a browser sets for files dragged in from the OS. */
const OS_FILE_DRAG_TYPE = "Files";

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

function hasType(
  transfer: Pick<DataTransfer, "types"> | null | undefined,
  type: string,
): boolean {
  const types = transfer?.types;
  if (types === undefined || types === null) return false;
  return Array.from(types).includes(type);
}

/**
 * True when a drag may be handled by an internal asset drop target.
 *
 * Used by `dragover` (which may only inspect the type list): OS file drags and
 * multi-selection payloads are not internal single-asset drags, so a stage can
 * ignore them without reading anything from the payload.
 */
export function isAssetDrag(
  transfer: Pick<DataTransfer, "types"> | null | undefined,
): boolean {
  if (transfer === null || transfer === undefined) return false;
  if (hasType(transfer, OS_FILE_DRAG_TYPE)) return false;
  if (hasType(transfer, ASSET_MULTI_DRAG_TYPE)) return false;
  return hasType(transfer, ASSET_DRAG_TYPE);
}

/**
 * The single background asset id an internal library drag may assign.
 *
 * Mirrors the asset chooser's contract: the id must be one of the project's
 * current assets of the accepted kind, and an asset the author hid from new
 * choices stays hidden here too.  Everything else — OS files, multi-selection
 * drags, unknown ids, wrong kinds, hidden assets — resolves to `null`, and the
 * caller consumes the drop without changing the node.
 */
export function resolveBackgroundDrop(
  transfer: Pick<DataTransfer, "getData" | "types"> | null,
  assets: readonly EditorAsset[],
  layout: EditorLayout | null | undefined,
): string | null {
  if (!isAssetDrag(transfer)) return null;
  const id = draggedAssetId(transfer, assets, ["background"]);
  if (id === null) return null;
  if (isAssetHidden(layout, id)) return null;
  return id;
}
