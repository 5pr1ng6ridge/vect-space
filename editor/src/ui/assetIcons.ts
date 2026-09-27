/** One icon per asset kind, shared by the asset library and choosers. */
import {
  AudioLines,
  Film,
  Image,
  LayoutTemplate,
  Music,
  PersonStanding,
  Type,
  Volume2,
  type LucideIcon,
} from "lucide-react";

import type { AssetKind } from "../types";

export const ASSET_KIND_ICONS: Record<AssetKind, LucideIcon> = {
  background: Image,
  sprite: PersonStanding,
  gui: LayoutTemplate,
  bgm: Music,
  ambience: AudioLines,
  sfx: Volume2,
  font: Type,
  video: Film,
};
