//! Cached native text/icons. Pointer movement changes only a Composition visual.
use crate::{color, style::*, v2, Icon, Model};
use windows::{
    core::*,
    Foundation::Size,
    Graphics::DirectX::*,
    Win32::{
        Foundation::*,
        Graphics::{
            Direct2D::{Common::*, *},
            Direct3D::*,
            Direct3D11::*,
            DirectWrite::*,
            Dxgi::*,
        },
        System::WinRT::Composition::*,
    },
    UI::Composition::*,
};
use windows_numerics::{Matrix3x2, Vector2, Vector3};
fn ink(r: u8, g: u8, b: u8, a: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F {
        r: r as f32 / 255.,
        g: g as f32 / 255.,
        b: b as f32 / 255.,
        a,
    }
}
pub struct Renderer {
    _d3d: ID3D11Device,
    _factory: ID2D1Factory1,
    _device: ID2D1Device,
    graphics: CompositionGraphicsDevice,
    compositor: Compositor,
    content: SpriteVisual,
    selection: ShapeVisual,
    selection_geometry: CompositionRoundedRectangleGeometry,
    selection_brush: CompositionColorBrush,
    labels: Vec<IDWriteTextLayout>,
    icons: Vec<Option<IDWriteTextLayout>>,
    shortcuts: Vec<IDWriteTextLayout>,
    model: Model,
    brushes: [Option<CompositionSurfaceBrush>; 2],
    marker: bool,
    applied_theme: Option<bool>,
    dpi: f32,
    selected: Option<usize>,
}
impl Renderer {
    pub unsafe fn new(
        compositor: &Compositor,
        host: &ContainerVisual,
        model: Model,
    ) -> Result<Self> {
        let mut d3d = None;
        let hardware = D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut d3d),
            None,
            None,
        );
        hardware?;
        let d3d = d3d.ok_or_else(|| Error::from(E_POINTER))?;
        let dxgi: IDXGIDevice = d3d.cast()?;
        let factory: ID2D1Factory1 = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
        let device = factory.CreateDevice(&dxgi)?;
        let interop: ICompositorInterop = compositor.cast()?;
        let graphics = interop.CreateGraphicsDevice(&device)?;
        model.validate()?;
        let (labels, icons, shortcuts) = Self::layouts(&model)?;
        let selection = compositor.CreateShapeVisual()?;
        let selection_geometry = compositor.CreateRoundedRectangleGeometry()?;
        let shape = compositor.CreateSpriteShapeWithGeometry(&selection_geometry)?;
        let selection_brush = compositor.CreateColorBrush()?;
        shape.SetFillBrush(&selection_brush)?;
        selection.Shapes()?.Append(&shape)?;
        selection.SetIsVisible(false)?;
        host.Children()?.InsertAtTop(&selection)?;
        let content = compositor.CreateSpriteVisual()?;
        host.Children()?.InsertAtTop(&content)?;
        Ok(Self {
            _d3d: d3d,
            _factory: factory,
            _device: device,
            graphics,
            compositor: compositor.clone(),
            content,
            selection,
            selection_geometry,
            selection_brush,
            labels,
            icons,
            shortcuts,
            model,
            brushes: [None, None],
            marker: false,
            applied_theme: None,
            dpi: 0.,
            selected: None,
        })
    }
    unsafe fn layouts(
        model: &Model,
    ) -> Result<(
        Vec<IDWriteTextLayout>,
        Vec<Option<IDWriteTextLayout>>,
        Vec<IDWriteTextLayout>,
    )> {
        let write: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
        let text = write.CreateTextFormat(
            w!("Microsoft YaHei UI"),
            None,
            DWRITE_FONT_WEIGHT_NORMAL,
            DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            14.,
            w!("en-us"),
        )?;
        text.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)?;
        text.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
        let icon = write.CreateTextFormat(
            w!("Segoe MDL2 Assets"),
            None,
            DWRITE_FONT_WEIGHT_NORMAL,
            DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            16.,
            w!("en-us"),
        )?;
        icon.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)?;
        icon.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER)?;
        let shortcut_format = write.CreateTextFormat(
            w!("Segoe UI"),
            None,
            DWRITE_FONT_WEIGHT_NORMAL,
            DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            12.,
            w!("en-us"),
        )?;
        shortcut_format.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)?;
        shortcut_format.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_TRAILING)?;
        shortcut_format.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
        let mut labels = vec![];
        let mut icons = vec![];
        let mut shortcuts = vec![];
        for item in &model.items {
            let label_width = model.width - 60. - if item.shortcut.is_empty() { 0. } else { 84. };
            labels.push(write.CreateTextLayout(
                &item.label.encode_utf16().collect::<Vec<_>>(),
                &text,
                label_width,
                model.row_height,
            )?);
            shortcuts.push(write.CreateTextLayout(
                &item.shortcut.encode_utf16().collect::<Vec<_>>(),
                &shortcut_format,
                80.,
                model.row_height,
            )?);
            icons.push(match &item.icon {
                Icon::Glyph(glyph) => {
                    Some(write.CreateTextLayout(&[*glyph], &icon, 20., model.row_height)?)
                }
                Icon::Rgba { .. } => None,
            });
        }
        Ok((labels, icons, shortcuts))
    }
    pub unsafe fn set_model(&mut self, model: Model) -> Result<()> {
        model.validate()?;
        let (labels, icons, shortcuts) = Self::layouts(&model)?;
        self.select(None)?;
        self.model = model;
        self.labels = labels;
        self.icons = icons;
        self.shortcuts = shortcuts;
        self.brushes = [None, None];
        self.applied_theme = None;
        self.dpi = 0.;
        Ok(())
    }
    pub unsafe fn appearance(&mut self, dpi: f32, dark: bool, marker: bool) -> Result<()> {
        // A retained surface must never conceal device loss behind a cache hit.
        self._d3d.GetDeviceRemovedReason()?;
        let dpi_changed = self.dpi != dpi;
        if dpi_changed || self.marker != marker {
            self.brushes = [None, None];
            self.applied_theme = None;
            self.marker = marker;
        }
        if self.dpi != dpi {
            self.dpi = dpi;
            self.content
                .SetSize(v2(self.model.width * dpi, self.model.height * dpi))?;
            self.selection.SetSize(v2(
                (self.model.width - 2. * ITEM_INSET) * dpi,
                self.model.row_height * dpi,
            ))?;
            self.selection_geometry.SetSize(v2(
                (self.model.width - 2. * ITEM_INSET) * dpi,
                self.model.row_height * dpi,
            ))?;
            self.selection_geometry
                .SetCornerRadius(v2(ITEM_CORNER * dpi, ITEM_CORNER * dpi))?;
            let selected = self.selected.take();
            self.select(selected)?;
        }
        if self.applied_theme == Some(dark) {
            return Ok(());
        }
        let [r, g, b] = palette(dark).text;
        self.selection_brush.SetColor(color(HOVER_ALPHA, r, g, b))?;
        // Prepare both themes once per DPI/diagnostic-marker change. Brushes
        // retain their surfaces, so theme changes allocate neither one again.
        for theme in [false, true] {
            let key = theme as usize;
            if self.brushes[key].is_none() {
                let surface = self.draw(theme, marker)?;
                self.brushes[key] = Some(self.compositor.CreateSurfaceBrushWithSurface(&surface)?);
            }
        }
        self.content
            .SetBrush(self.brushes[dark as usize].as_ref().unwrap())?;
        self.applied_theme = Some(dark);
        Ok(())
    }
    unsafe fn draw(&self, dark: bool, marker: bool) -> Result<CompositionDrawingSurface> {
        let surface = self.graphics.CreateDrawingSurface(
            Size {
                Width: (self.model.width * self.dpi).ceil(),
                Height: (self.model.height * self.dpi).ceil(),
            },
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            DirectXAlphaMode::Premultiplied,
        )?;
        let interop: ICompositionDrawingSurfaceInterop = surface.cast()?;
        let mut offset = POINT::default();
        let dc: ID2D1DeviceContext = interop.BeginDraw(None, &mut offset)?;
        let result = (|| -> Result<()> {
            // BeginDraw's offset is in physical pixels; D2D coordinates below are DIP.
            dc.SetDpi(96. * self.dpi, 96. * self.dpi);
            dc.SetTransform(&Matrix3x2 {
                M11: 1.,
                M12: 0.,
                M21: 0.,
                M22: 1.,
                M31: offset.x as f32 / self.dpi,
                M32: offset.y as f32 / self.dpi,
            });
            dc.Clear(Some(&ink(0, 0, 0, 0.)));
            dc.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
            let palette = palette(dark);
            let brush = |[r, g, b]: [u8; 3]| dc.CreateSolidColorBrush(&ink(r, g, b, 1.), None);
            let normal = brush(palette.text)?;
            let danger = brush(palette.danger)?;
            let muted = brush(palette.muted)?;
            for (i, item) in self.model.items.iter().enumerate() {
                let brush = if item.danger { &danger } else { &normal };
                dc.DrawTextLayout(
                    Vector2 {
                        X: 44.,
                        Y: self.model.tops[i],
                    },
                    &self.labels[i],
                    brush,
                    D2D1_DRAW_TEXT_OPTIONS_NONE,
                );
                if let Some(icon) = &self.icons[i] {
                    dc.DrawTextLayout(
                        Vector2 {
                            X: 16.,
                            Y: self.model.tops[i],
                        },
                        icon,
                        brush,
                        D2D1_DRAW_TEXT_OPTIONS_NONE,
                    );
                } else if let Icon::Rgba {
                    pixels,
                    width,
                    height,
                } = &item.icon
                {
                    // Source icons are alpha masks from the canonical Lucide assets.
                    // Tint/premultiply once when this cached theme surface is created.
                    let rgb = (if item.danger {
                        palette.danger
                    } else {
                        palette.text
                    })
                    .map(u32::from);
                    let mut bgra = Vec::with_capacity(pixels.len());
                    for p in pixels.chunks_exact(4) {
                        let a = p[3] as u32;
                        bgra.extend_from_slice(&[
                            (rgb[2] * a / 255) as u8,
                            (rgb[1] * a / 255) as u8,
                            (rgb[0] * a / 255) as u8,
                            p[3],
                        ]);
                    }
                    let bitmap = dc.CreateBitmap(
                        D2D_SIZE_U { width: *width, height: *height }, Some(bgra.as_ptr().cast()),
                        width * 4, &D2D1_BITMAP_PROPERTIES1 {
                            pixelFormat: D2D1_PIXEL_FORMAT { format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
                                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED },
                            dpiX: 96., dpiY: 96., ..Default::default()
                        })?;
                    dc.DrawBitmap(
                        &bitmap,
                        Some(&D2D_RECT_F {
                            left: 18.,
                            top: self.model.tops[i] + (self.model.row_height - 16.) / 2.,
                            right: 34.,
                            bottom: self.model.tops[i] + (self.model.row_height + 16.) / 2.,
                        }),
                        1.,
                        D2D1_INTERPOLATION_MODE_LINEAR,
                        None,
                        None,
                    );
                }
                dc.DrawTextLayout(
                    Vector2 {
                        X: self.model.width - 96.,
                        Y: self.model.tops[i],
                    },
                    &self.shortcuts[i],
                    &muted,
                    D2D1_DRAW_TEXT_OPTIONS_NONE,
                );
            }
            let line = dc.CreateSolidColorBrush(
                &if dark {
                    ink(255, 255, 255, palette.divider)
                } else {
                    ink(0, 0, 0, palette.divider)
                },
                None,
            )?;
            for separator in &self.model.separators {
                dc.DrawLine(
                    Vector2 {
                        X: 12.,
                        Y: (*separator * self.dpi).floor() / self.dpi + 0.5 / self.dpi,
                    },
                    Vector2 {
                        X: self.model.width - 12.,
                        Y: (*separator * self.dpi).floor() / self.dpi + 0.5 / self.dpi,
                    },
                    &line,
                    1. / self.dpi,
                    None,
                );
            }
            // A one-physical-pixel stroke centered half a pixel inside the
            // surface stays inside its clip. Cache it alongside text, never
            // redraw it on hover/open, and keep the interior fully transparent.
            let stroke = 1. / self.dpi;
            let inset = stroke / 2.;
            let border = dc.CreateSolidColorBrush(
                &if dark {
                    ink(255, 255, 255, BORDER_ALPHA)
                } else {
                    ink(0, 0, 0, BORDER_ALPHA)
                },
                None,
            )?;
            dc.DrawRoundedRectangle(
                &D2D1_ROUNDED_RECT {
                    rect: D2D_RECT_F {
                        left: inset,
                        top: inset,
                        right: self.model.width - inset,
                        bottom: self.model.height - inset,
                    },
                    radiusX: CORNER - inset,
                    radiusY: CORNER - inset,
                },
                &border,
                stroke,
                None,
            );
            if marker {
                let brush = dc.CreateSolidColorBrush(&ink(38, 201, 128, 1.), None)?;
                dc.FillRectangle(
                    &D2D_RECT_F {
                        left: self.model.width - 20.,
                        top: 14.,
                        right: self.model.width - 16.,
                        bottom: 18.,
                    },
                    &brush,
                );
            }
            Ok(())
        })();
        // Composition owns the D2D drawing session: do not call dc.BeginDraw/EndDraw.
        let end = interop.EndDraw();
        result?;
        end?;
        Ok(surface)
    }
    pub fn select(&mut self, index: Option<usize>) -> Result<()> {
        if self.selected == index {
            return Ok(());
        }
        self.selected = index;
        if let Some(i) = index {
            self.selection.SetOffset(Vector3 {
                X: ITEM_INSET * self.dpi,
                Y: self.model.tops[i] * self.dpi,
                Z: 0.,
            })?;
            self.selection.SetIsVisible(true)?;
        } else {
            self.selection.SetIsVisible(false)?;
        }
        Ok(())
    }
    pub fn model(&self) -> &Model {
        &self.model
    }
    pub fn selected(&self) -> Option<usize> {
        self.selected
    }
}
