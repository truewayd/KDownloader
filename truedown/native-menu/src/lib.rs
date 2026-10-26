//! Shared retained native rendering for the prototype and TrueDown.
#![cfg(windows)]
use windows::{core::*, UI::Color};
use windows_numerics::Vector2;
mod host;
pub mod render;
pub mod style;
pub use host::{dismiss, key, park_popup, show_popup, track};
pub use style::CORNER;
pub fn v2(x: f32, y: f32) -> Vector2 {
    Vector2 { X: x, Y: y }
}
pub fn color(a: u8, r: u8, g: u8, b: u8) -> Color {
    Color {
        A: a,
        R: r,
        G: g,
        B: b,
    }
}
#[derive(Clone)]
pub enum Icon {
    Glyph(u16),
    Rgba {
        pixels: Vec<u8>,
        width: u32,
        height: u32,
    },
}
#[derive(Clone)]
pub struct Item {
    pub label: String,
    pub shortcut: String,
    pub danger: bool,
    pub icon: Icon,
}
#[derive(Clone)]
pub struct Model {
    pub width: f32,
    pub height: f32,
    pub row_height: f32,
    pub items: Vec<Item>,
    pub tops: Vec<f32>,
    pub separators: Vec<f32>,
}
impl Model {
    pub fn validate(&self) -> Result<()> {
        if self.items.is_empty()
            || self.items.len() > 32
            || self.tops.len() != self.items.len()
            || !self.width.is_finite()
            || !(160. ..=640.).contains(&self.width)
            || !self.height.is_finite()
            || !(32. ..=1200.).contains(&self.height)
            || !self.row_height.is_finite()
            || !(24. ..=64.).contains(&self.row_height)
            || self.tops.iter().enumerate().any(|(i, y)| {
                !y.is_finite()
                    || *y < 0.
                    || *y + self.row_height > self.height
                    || (i > 0 && *y < self.tops[i - 1] + self.row_height)
            })
            || self
                .separators
                .iter()
                .any(|y| !y.is_finite() || *y < 0. || *y > self.height)
        {
            return Err(Error::from(windows::Win32::Foundation::E_INVALIDARG));
        }
        for item in &self.items {
            if item.label.len() > 512 || item.shortcut.len() > 128 {
                return Err(Error::from(windows::Win32::Foundation::E_INVALIDARG));
            }
            if let Icon::Rgba {
                pixels,
                width,
                height,
            } = &item.icon
            {
                if *width == 0
                    || *height == 0
                    || *width > 64
                    || *height > 64
                    || pixels.len() != (*width as usize) * (*height as usize) * 4
                {
                    return Err(Error::from(windows::Win32::Foundation::E_INVALIDARG));
                }
            }
        }
        Ok(())
    }
    pub fn inside(&self, x: f32, y: f32) -> bool {
        (0. ..self.width).contains(&x)
            && (0. ..self.height).contains(&y)
            && (x - x.clamp(CORNER, self.width - CORNER)).powi(2)
                + (y - y.clamp(CORNER, self.height - CORNER)).powi(2)
                <= CORNER * CORNER
    }
    pub fn row_at(&self, x: f32, y: f32) -> Option<usize> {
        if !self.inside(x, y) || !(style::ITEM_INSET..self.width - style::ITEM_INSET).contains(&x) {
            return None;
        }
        self.tops
            .iter()
            .position(|top| y >= *top && y < *top + self.row_height)
    }
}
