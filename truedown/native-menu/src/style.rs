//! Native projection of web/ui-baseline.css and web/native-appearance.css.
//! Keep these product tokens shared by the prototype, content and tray menus.
pub const CORNER: f32 = 16.;
pub const ITEM_CORNER: f32 = 10.;
// The web menu has 4 DIP padding plus its 1 DIP border.
pub const ITEM_INSET: f32 = 5.;
pub const ROW_HEIGHT: f32 = 32.;
pub const SHADOW_PAD: f32 = 20.;
pub const SHADOW_BLUR: f32 = 16.;
pub const SHADOW_OFFSET: f32 = 4.;
pub const TINT_ALPHA: u8 = 184;
pub const HOVER_ALPHA: u8 = 20; // 8% of --kd-text on native material.
pub const BORDER_ALPHA: f32 = 0.20; // --kd-border-strong on .kd-context-menu.
pub struct Palette {
    pub surface: [u8; 3],
    pub text: [u8; 3],
    pub muted: [u8; 3],
    pub danger: [u8; 3],
    pub hover: [u8; 3],
    pub shadow: f32,
    pub divider: f32,
}
pub fn palette(dark: bool) -> Palette {
    if dark {
        Palette {
            surface: [43; 3],
            text: [245; 3],
            muted: [188; 3],
            danger: [242, 198, 193],
            hover: [59; 3],
            shadow: 0.14,
            divider: 0.09,
        }
    } else {
        Palette {
            surface: [255; 3],
            text: [32; 3],
            muted: [96; 3],
            danger: [139, 51, 38],
            hover: [240; 3],
            shadow: 0.08,
            divider: 0.08,
        }
    }
}
