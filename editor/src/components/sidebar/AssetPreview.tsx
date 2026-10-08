import type { ReactElement } from "react";
import { assetUrl } from "../../api";
import { animationSourceId } from "../../imageAnimation";
import { useAssetFont } from "../../useAssetFont";
import { FrameSequencePreview } from "../FrameSequencePreview";
import type { AnimationFile, EditorAsset } from "../../types";
import { assetSize, previewFramesFor } from "./assetUtils";

export function AssetPreview({
  asset,
  assets,
  animations,
}: {
  asset: EditorAsset;
  assets: readonly EditorAsset[];
  animations: readonly AnimationFile[];
}): ReactElement {
  const url = assetUrl(asset.absolute_path);
  const font = useAssetFont(
    asset.kind === "font" ? url : undefined,
    `Asset ${asset.id}`,
  );
  const animation = animationSourceId(asset.animation ?? "", animations);
  if (animation !== undefined) {
    const size = assetSize(asset);
    return (
      <FrameSequencePreview
        frames={previewFramesFor(animation, assets)}
        height={size?.height}
        label={`素材 ${asset.id}`}
        width={size?.width}
      />
    );
  }
  if (["background", "sprite", "gui"].includes(asset.kind)) {
    return <img alt={asset.id} className="asset-preview" src={url} />;
  }
  if (
    asset.kind === "bgm" ||
    asset.kind === "ambience" ||
    asset.kind === "sfx"
  ) {
    return <audio className="asset-audio" controls src={url} />;
  }
  if (asset.kind === "video") {
    return (
      <video className="asset-preview" controls preload="metadata" src={url} />
    );
  }
  return (
    <div className="font-preview" style={{ fontFamily: font.fontFamily }}>
      {font.error === null ? "Aa 数学 123" : `字体加载失败：${font.error}`}
    </div>
  );
}
