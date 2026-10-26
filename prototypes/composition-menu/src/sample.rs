//! Bounded screen sampling of the prototype's synthetic background, never the desktop.
use std::{io::Write, path::Path};
use windows::{
    core::*,
    Win32::{Foundation::*, Graphics::Gdi::*, UI::WindowsAndMessaging::*},
};
pub struct Sampler {
    pub width: i32,
    pub height: i32,
    dc: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
    bits: *mut u8,
}
pub struct Metrics {
    pub black_ratio: f64,
    pub green_ratio: f64,
}
impl Sampler {
    pub unsafe fn new(width: i32, height: i32) -> Result<Self> {
        if !(1..=2048).contains(&width) || !(1..=2048).contains(&height) {
            return Err(Error::from(E_INVALIDARG));
        }
        let dc = CreateCompatibleDC(None);
        if dc.is_invalid() {
            return Err(Error::from_thread());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as _,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
        let old = SelectObject(dc, bitmap.into());
        Ok(Self {
            width,
            height,
            dc,
            bitmap,
            old,
            bits: bits.cast(),
        })
    }
    pub unsafe fn read(&mut self, x: i32, y: i32) -> Result<Metrics> {
        let screen = GetDC(None);
        let r = BitBlt(
            self.dc,
            0,
            0,
            self.width,
            self.height,
            Some(screen),
            x,
            y,
            SRCCOPY | CAPTUREBLT,
        );
        ReleaseDC(None, screen);
        r?;
        let _ = GdiFlush();
        let bytes = std::slice::from_raw_parts(self.bits, (self.width * self.height * 4) as usize);
        Ok(classify(bytes, self.width, self.height))
    }
    pub unsafe fn save(&self, path: &Path) -> std::io::Result<()> {
        let size = (self.width * self.height * 4) as u32;
        let mut f = std::fs::File::create(path)?;
        f.write_all(b"BM")?;
        f.write_all(&(54 + size).to_le_bytes())?;
        f.write_all(&[0; 4])?;
        f.write_all(&54u32.to_le_bytes())?;
        f.write_all(&40u32.to_le_bytes())?;
        f.write_all(&self.width.to_le_bytes())?;
        f.write_all(&(-self.height).to_le_bytes())?;
        f.write_all(&1u16.to_le_bytes())?;
        f.write_all(&32u16.to_le_bytes())?;
        f.write_all(&[0; 24])?;
        f.write_all(std::slice::from_raw_parts(self.bits, size as usize))
    }
}
fn classify(bytes: &[u8], width: i32, height: i32) -> Metrics {
    let (mut black, mut green, mut count) = (0, 0, 0);
    // Exclude only the rounded perimeter, retain the entire content interior.
    for y in (8..height - 8).step_by(2) {
        for x in (8..width - 8).step_by(2) {
            let i = ((y * width + x) * 4) as usize;
            let (b, g, r) = (bytes[i], bytes[i + 1], bytes[i + 2]);
            count += 1;
            if r < 12 && g < 12 && b < 12 {
                black += 1
            }
            if g > 150 && r < 80 && b > 80 && b < 170 {
                green += 1
            }
        }
    }
    Metrics {
        black_ratio: black as f64 / count.max(1) as f64,
        green_ratio: green as f64 / count.max(1) as f64,
    }
}
impl Drop for Sampler {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}
pub unsafe fn paint_reference(hwnd: HWND) {
    let mut ps = PAINTSTRUCT::default();
    let dc = BeginPaint(hwnd, &mut ps);
    let mut r = RECT::default();
    let _ = GetClientRect(hwnd, &mut r);
    for y in (0..r.bottom).step_by(40) {
        for x in (0..r.right).step_by(40) {
            let c = if (x / 40 + y / 40) % 2 == 0 {
                0x00c8b678
            } else {
                0x007e639f
            };
            let brush = CreateSolidBrush(COLORREF(c));
            FillRect(
                dc,
                &RECT {
                    left: x,
                    top: y,
                    right: x + 40,
                    bottom: y + 40,
                },
                brush,
            );
            let _ = DeleteObject(brush.into());
        }
    }
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, COLORREF(0x00ffffff));
    for (y, s) in [
        (
            18,
            "Right click: menu | F2: theme | F3: blur/solid | F5: cycles",
        ),
        (
            42,
            "Esc: dismiss/stop | Actions are synthetic. No downloads or clipboard access.",
        ),
    ] {
        let text: Vec<u16> = s.encode_utf16().collect();
        let _ = TextOutW(dc, 16, y, &text);
    }
    let _ = EndPaint(hwnd, &ps);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_black_failure_from_valid_dark_surface() {
        assert_eq!(classify(&vec![0; 64 * 64 * 4], 64, 64).black_ratio, 1.);
        assert_eq!(classify(&vec![32; 64 * 64 * 4], 64, 64).black_ratio, 0.);
    }
    #[test]
    fn recognizes_content_marker_and_partial_black_panel() {
        let mut pixels = vec![243u8; 64 * 64 * 4];
        for y in 16..48 {
            for x in 16..48 {
                let i = (y * 64 + x) * 4;
                pixels[i..i + 4].copy_from_slice(&[0, 0, 0, 255]);
            }
        }
        assert!(classify(&pixels, 64, 64).black_ratio > 0.4);
        for p in pixels.chunks_exact_mut(4) {
            p.copy_from_slice(&[128, 201, 38, 255]);
        }
        assert_eq!(classify(&pixels, 64, 64).green_ratio, 1.);
    }
}
