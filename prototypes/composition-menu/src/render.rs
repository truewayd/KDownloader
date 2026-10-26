//! The independent prototype exercises the same retained renderer as TrueDown.
use crate::{CORNER, H, W};
use truedown_native_menu::{Icon, Item, Model};
use windows::{core::*, UI::Composition::*};
pub const ROW_TOPS: [f32; 5] = [5., 37., 69., 101., 142.];
const ROW_HEIGHT: f32 = truedown_native_menu::style::ROW_HEIGHT;
const ROW_INSET: f32 = truedown_native_menu::style::ITEM_INSET;
pub fn inside(x: f32, y: f32) -> bool {
    (0.0..W).contains(&x)
        && (0.0..H).contains(&y)
        && (x - x.clamp(CORNER, W - CORNER)).powi(2) + (y - y.clamp(CORNER, H - CORNER)).powi(2)
            <= CORNER * CORNER
}
pub fn row_at(x: f32, y: f32) -> Option<usize> {
    if !(ROW_INSET..W - ROW_INSET).contains(&x) {
        return None;
    }
    ROW_TOPS
        .iter()
        .position(|top| y >= *top && y < *top + ROW_HEIGHT)
}
pub struct Renderer(truedown_native_menu::render::Renderer);
impl Renderer {
    pub unsafe fn new(compositor: &Compositor, host: &ContainerVisual) -> Result<Self> {
        let items = [
            ("Details", 0xe946),
            ("Resume", 0xe768),
            ("Open folder", 0xe8b7),
            ("Copy link", 0xe8c8),
            ("Remove", 0xe74d),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, (label, glyph))| Item {
            label: label.into(),
            shortcut: String::new(),
            danger: i == 4,
            icon: Icon::Glyph(glyph),
        })
        .collect();
        Ok(Self(truedown_native_menu::render::Renderer::new(
            compositor,
            host,
            Model {
                width: W,
                height: H,
                row_height: ROW_HEIGHT,
                items,
                tops: ROW_TOPS.to_vec(),
                separators: vec![137.],
            },
        )?))
    }
    pub unsafe fn appearance(&mut self, dpi: f32, dark: bool, marker: bool) -> Result<()> {
        self.0.appearance(dpi, dark, marker)
    }
    pub fn select(&mut self, index: Option<usize>) -> Result<()> {
        self.0.select(index)
    }
    pub fn selected(&self) -> Option<usize> {
        self.0.selected()
    }
}
