import type { ReactElement } from "react";

import { MarkupText } from "@vectspace/presentation-react/gameplay";

interface TitleScreenProps {
  busy: boolean;
  canContinue: boolean;
  chapterMapAvailable: boolean;
  contentVersion: string;
  onStart(): void;
  onContinue(): void;
  onOpenSaves(): void;
  onOpenSettings(): void;
  onOpenChapterMap(): void;
}

export function TitleScreen({
  busy,
  canContinue,
  chapterMapAvailable,
  contentVersion,
  onStart,
  onContinue,
  onOpenSaves,
  onOpenSettings,
  onOpenChapterMap,
}: TitleScreenProps): ReactElement {
  return (
    <div className="title-screen">
      <div className="title-card">
        <p className="eyebrow">A MATHEMATICAL VISUAL NOVEL</p>
        <h1>VECTSPACE</h1>
        <p className="title-formula">
          <MarkupText source="$V=U\oplus W$" />
        </p>
        <div className="title-actions">
          <button disabled={busy} onClick={onStart} type="button">
            开始演示
          </button>
          <button
            disabled={!canContinue || busy}
            onClick={onContinue}
            type="button"
          >
            继续
          </button>
          <button onClick={onOpenSaves} type="button">
            读取存档
          </button>
          <button onClick={onOpenSettings} type="button">
            设置
          </button>
          <button
            disabled={!chapterMapAvailable}
            onClick={onOpenChapterMap}
            type="button"
          >
            章节地图
          </button>
        </div>
        <small>内容版本 {contentVersion || "未载入"}</small>
      </div>
    </div>
  );
}
