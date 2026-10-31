//! Pure, deterministic choice-flow layout.
//!
//! The runtime filters and interpolates the visible choices, resolves each
//! item's effective size (option template, node template, built-in fallback),
//! then calls [`layout_choice_items`] to place the group in the fixed
//! 1920x1080 design space.  Anchor coordinates are design pixels, never
//! normalized fractions: `(960, 540)` is the stage centre.  Hosts render the
//! resulting rects directly, so the same conformance corpus
//! (`fixtures/choice-layout-cases.json`) is mirrored by the
//! framework-agnostic TypeScript helper in `packages/presentation-core`.

use serde::{Deserialize, Serialize};

use crate::model::{ChoiceFlowDirection, CHOICE_FALLBACK_PANEL_X, CHOICE_FALLBACK_PANEL_Y};

/// One resolved item rect in design pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ChoiceItemRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Bounding box of the whole visible group plus the per-item rects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChoiceLayoutResult {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub items: Vec<ChoiceItemRect>,
}

/// Extent of the whole group as `(main, cross)` lengths in design pixels.
///
/// `main` is the direction the items flow along and includes the gaps; `cross`
/// is the longest item on the perpendicular axis.  The result is `(0, 0)` for
/// an empty group, so callers can collapse such a group onto its anchor.
pub fn choice_group_extent(
    direction: ChoiceFlowDirection,
    gap: f32,
    sizes: &[(f32, f32)],
) -> (f32, f32) {
    if sizes.is_empty() {
        return (0.0, 0.0);
    }
    let horizontal = direction == ChoiceFlowDirection::Horizontal;
    let mut total_main = 0.0f32;
    let mut max_cross = 0.0f32;
    for (width, height) in sizes {
        let (main, cross) = if horizontal {
            (*width, *height)
        } else {
            (*height, *width)
        };
        total_main += main;
        max_cross = max_cross.max(cross);
    }
    total_main += gap * (sizes.len() as f32 - 1.0);
    (total_main, max_cross)
}

/// Equivalent centre anchor of the shipped CSS choice panel.
///
/// A node without `presentation` keeps the panel top-left at
/// `(470, 360)`, so its group-centre anchor depends on the resolved group
/// extent.  Deriving the anchor here — instead of re-anchoring the layout —
/// keeps one centring rule for every choice node: the reported layout is
/// always `layout_choice_items(direction, anchor_x, anchor_y, gap, sizes)`.
///
/// The mapping is axis-aware: a vertical flow stacks along `y`, so the panel
/// origin is reached by offsetting `anchor_y` by half the main extent; a
/// horizontal flow stacks along `x` and offsets `anchor_x` instead.  Callers
/// may pass either direction and still get a layout whose bounding box starts
/// at the shipped panel origin.
pub fn legacy_choice_anchor(
    direction: ChoiceFlowDirection,
    gap: f32,
    sizes: &[(f32, f32)],
) -> (f32, f32) {
    let (total_main, max_cross) = choice_group_extent(direction, gap, sizes);
    if direction == ChoiceFlowDirection::Horizontal {
        (
            CHOICE_FALLBACK_PANEL_X + total_main / 2.0,
            CHOICE_FALLBACK_PANEL_Y + max_cross / 2.0,
        )
    } else {
        (
            CHOICE_FALLBACK_PANEL_X + max_cross / 2.0,
            CHOICE_FALLBACK_PANEL_Y + total_main / 2.0,
        )
    }
}

/// Places visible choice buttons in the fixed 1920x1080 stage.
///
/// The group is centred on `anchor_x`/`anchor_y` (design pixels, `0..=1920`
/// and `0..=1080`) and flows along `direction`, separated by `gap` design
/// pixels.  Every item is centred on the cross axis, so mixed template sizes
/// stay visually aligned while the main axis advances by each item's own size
/// plus the gap.  Positions are deterministic for a given order and never
/// depend on camera or viewport.
pub fn layout_choice_items(
    direction: ChoiceFlowDirection,
    anchor_x: f32,
    anchor_y: f32,
    gap: f32,
    sizes: &[(f32, f32)],
) -> ChoiceLayoutResult {
    if sizes.is_empty() {
        return ChoiceLayoutResult {
            x: anchor_x,
            y: anchor_y,
            width: 0.0,
            height: 0.0,
            items: Vec::new(),
        };
    }
    let horizontal = direction == ChoiceFlowDirection::Horizontal;
    let (total_main, max_cross) = choice_group_extent(direction, gap, sizes);
    let (anchor_main, anchor_cross) = if horizontal {
        (anchor_x, anchor_y)
    } else {
        (anchor_y, anchor_x)
    };
    let start_main = anchor_main - total_main / 2.0;
    let cross_origin = anchor_cross - max_cross / 2.0;
    let mut cursor = start_main;
    let mut items = Vec::with_capacity(sizes.len());
    for (width, height) in sizes {
        let (x, y) = if horizontal {
            (cursor, anchor_cross - height / 2.0)
        } else {
            (anchor_cross - width / 2.0, cursor)
        };
        items.push(ChoiceItemRect {
            x,
            y,
            width: *width,
            height: *height,
        });
        cursor += if horizontal { *width } else { *height } + gap;
    }
    let (x, y, width, height) = if horizontal {
        (start_main, cross_origin, total_main, max_cross)
    } else {
        (cross_origin, start_main, max_cross, total_main)
    };
    ChoiceLayoutResult {
        x,
        y,
        width,
        height,
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct LayoutCase {
        name: String,
        direction: ChoiceFlowDirection,
        anchor_x: f32,
        anchor_y: f32,
        gap: f32,
        items: Vec<SizeCase>,
        expected: ChoiceLayoutResult,
    }

    #[derive(serde::Deserialize)]
    struct SizeCase {
        width: f32,
        height: f32,
    }

    #[test]
    fn shared_layout_conformance_corpus_matches() {
        let cases: Vec<LayoutCase> =
            serde_json::from_str(include_str!("../../../fixtures/choice-layout-cases.json"))
                .expect("choice layout corpus must parse");
        assert!(!cases.is_empty());
        for case in cases {
            let sizes: Vec<(f32, f32)> = case
                .items
                .iter()
                .map(|item| (item.width, item.height))
                .collect();
            let result = layout_choice_items(
                case.direction,
                case.anchor_x,
                case.anchor_y,
                case.gap,
                &sizes,
            );
            assert_eq!(result, case.expected, "{}", case.name);
        }
    }

    #[test]
    fn vertical_mixed_sizes_centre_every_item_on_the_anchor() {
        let result = layout_choice_items(
            ChoiceFlowDirection::Vertical,
            960.0,
            540.0,
            20.0,
            &[(240.0, 72.0), (320.0, 88.0)],
        );
        assert_eq!(result.items[0].x, 840.0);
        assert_eq!(result.items[0].y, 450.0);
        assert_eq!(result.items[1].x, 800.0);
        assert_eq!(result.items[1].y, 542.0);
        assert_eq!(
            (result.x, result.y, result.width, result.height),
            (800.0, 450.0, 320.0, 180.0)
        );
    }

    #[test]
    fn horizontal_flow_advances_on_the_x_axis() {
        let result = layout_choice_items(
            ChoiceFlowDirection::Horizontal,
            960.0,
            540.0,
            16.0,
            &[(200.0, 80.0), (300.0, 120.0)],
        );
        assert_eq!(
            result.items[0],
            ChoiceItemRect {
                x: 702.0,
                y: 500.0,
                width: 200.0,
                height: 80.0,
            }
        );
        assert_eq!(
            result.items[1],
            ChoiceItemRect {
                x: 918.0,
                y: 480.0,
                width: 300.0,
                height: 120.0,
            }
        );
        assert_eq!(
            (result.x, result.y, result.width, result.height),
            (702.0, 480.0, 516.0, 120.0)
        );
    }

    #[test]
    fn anchors_are_design_pixels_not_normalized_fractions() {
        // A 0.5 anchor is half a design pixel from the top-left corner, not
        // the stage centre.
        let result = layout_choice_items(
            ChoiceFlowDirection::Vertical,
            0.5,
            0.5,
            0.0,
            &[(10.0, 10.0)],
        );
        assert_eq!(
            result.items[0],
            ChoiceItemRect {
                x: -4.5,
                y: -4.5,
                width: 10.0,
                height: 10.0,
            }
        );
    }

    #[test]
    fn legacy_anchor_is_axis_aware_for_a_horizontal_flow() {
        // The legacy panel origin has no horizontal predecessor, but the
        // public helper must still describe a layout whose bounding box
        // starts at the documented origin instead of silently re-anchoring.
        let sizes = [(240.0, 72.0), (320.0, 88.0)];
        let (anchor_x, anchor_y) =
            legacy_choice_anchor(ChoiceFlowDirection::Horizontal, 16.0, &sizes);
        assert_eq!((anchor_x, anchor_y), (758.0, 404.0));
        let result = layout_choice_items(
            ChoiceFlowDirection::Horizontal,
            anchor_x,
            anchor_y,
            16.0,
            &sizes,
        );
        assert_eq!(
            (result.x, result.y, result.width, result.height),
            (470.0, 360.0, 576.0, 88.0)
        );
        assert_eq!(result.items[0].x, 470.0);
        assert_eq!(result.items[1].x, 726.0);
        assert_eq!(result.items[0].y, 368.0);
        assert_eq!(result.items[1].y, 360.0);
    }
}
