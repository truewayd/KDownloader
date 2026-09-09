use std::{collections::HashMap, sync::Mutex};
use tauri::{LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, Window};

#[derive(Clone, PartialEq)]
struct WorkArea {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
}

impl From<&Monitor> for WorkArea {
    fn from(monitor: &Monitor) -> Self {
        Self {
            position: monitor.work_area().position,
            size: monitor.work_area().size,
            scale: monitor.scale_factor(),
        }
    }
}

#[derive(Default)]
pub struct Tracker {
    areas: Mutex<HashMap<String, WorkArea>>,
}

impl Tracker {
    fn changed(&self, label: &str, area: WorkArea) -> bool {
        let Ok(mut areas) = self.areas.lock() else {
            return false;
        };
        areas
            .insert(label.to_owned(), area.clone())
            .is_some_and(|previous| previous != area)
    }
}

// Same-DPI monitor moves do not produce ScaleFactorChanged. Refit only when
// the work area changes, so ordinary dragging within a screen stays OS-owned.
pub fn moved(window: &Window) {
    let (Some(tracker), Ok(Some(monitor))) =
        (window.try_state::<Tracker>(), window.current_monitor())
    else {
        return;
    };
    if tracker.changed(window.label(), WorkArea::from(&monitor)) {
        fit(window, false);
    }
}

fn dimensions(
    requested: (f64, f64),
    minimum: (f64, f64),
    available: (f64, f64),
) -> ((f64, f64), (f64, f64)) {
    let maximum = (available.0.max(1.0), available.1.max(1.0));
    let minimum = (minimum.0.min(maximum.0), minimum.1.min(maximum.1));
    (
        (
            requested.0.clamp(minimum.0, maximum.0),
            requested.1.clamp(minimum.1, maximum.1),
        ),
        minimum,
    )
}

// Measure the actual native frame and monitor work area. Fixed minimum sizes
// must not force controls below a taskbar on small screens at high scale.
pub fn fit(window: &Window, center: bool) {
    let preferred = if center && window.label() != "main" {
        window
            .app_handle()
            .get_webview_window("main")
            .and_then(|main| main.current_monitor().ok().flatten())
    } else {
        None
    };
    let monitor = preferred
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let (Ok(inner), Ok(outer), Ok(position), Ok(scale)) = (
        window.inner_size(),
        window.outer_size(),
        window.outer_position(),
        window.scale_factor(),
    ) else {
        return;
    };
    let target_scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 || !target_scale.is_finite() || target_scale <= 0.0 {
        return;
    }
    if let Some(tracker) = window.try_state::<Tracker>() {
        tracker.changed(window.label(), WorkArea::from(&monitor));
    }
    let frame = (
        (outer.width.saturating_sub(inner.width)) as f64 / scale,
        (outer.height.saturating_sub(inner.height)) as f64 / scale,
    );
    let area = monitor.work_area();
    let available = (
        area.size.width as f64 / target_scale - frame.0,
        area.size.height as f64 / target_scale - frame.1,
    );
    let minimum = crate::windows::minimum_size(window.label());
    let requested = (inner.width as f64 / scale, inner.height as f64 / scale);
    let (size, minimum) = dimensions(requested, minimum, available);
    let _ = window.set_min_size(Some(LogicalSize::new(minimum.0, minimum.1)));
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }
    if size != requested {
        let _ = window.set_size(LogicalSize::new(size.0, size.1));
    }
    let width = ((size.0 + frame.0) * target_scale).ceil() as i32;
    let height = ((size.1 + frame.1) * target_scale).ceil() as i32;
    let right = area
        .position
        .x
        .saturating_add((area.size.width as i32 - width).max(0));
    let bottom = area
        .position
        .y
        .saturating_add((area.size.height as i32 - height).max(0));
    let target = if center {
        PhysicalPosition::new(
            area.position.x + (right - area.position.x) / 2,
            area.position.y + (bottom - area.position.y) / 2,
        )
    } else {
        PhysicalPosition::new(
            position.x.clamp(area.position.x, right),
            position.y.clamp(area.position.y, bottom),
        )
    };
    if target != position {
        let _ = window.set_position(target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fitting_tracks_each_window_and_ignores_moves_within_one_work_area() {
        let tracker = Tracker::default();
        let large = WorkArea {
            position: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(1920, 1040),
            scale: 1.0,
        };
        let small = WorkArea {
            position: PhysicalPosition::new(1920, 0),
            size: PhysicalSize::new(1280, 680),
            scale: 1.0,
        };
        assert!(!tracker.changed("main", large.clone()));
        assert!(!tracker.changed("main", large.clone()));
        assert!(!tracker.changed("settings", small.clone()));
        assert!(tracker.changed("main", small.clone()));
        assert!(!tracker.changed("main", small.clone()));
        assert!(tracker.changed(
            "main",
            WorkArea {
                scale: 1.5,
                ..small
            }
        ));
        assert!(!tracker.changed(
            "settings",
            WorkArea {
                position: PhysicalPosition::new(1920, 0),
                size: PhysicalSize::new(1280, 680),
                scale: 1.0,
            }
        ));
    }

    #[test]
    fn small_high_scale_work_areas_override_fixed_minimums() {
        assert_eq!(
            dimensions(
                (520.0, 420.0),
                crate::windows::minimum_size("new-task"),
                (1200.0, 800.0)
            )
            .0,
            (520.0, 420.0)
        );
        let (size, minimum) = dimensions((1020.0, 760.0), (640.0, 480.0), (630.0, 310.0));
        assert_eq!(size, (630.0, 310.0));
        assert_eq!(minimum, size);
        assert_eq!(
            dimensions((560.0, 500.0), (420.0, 360.0), (1200.0, 700.0)).0,
            (560.0, 500.0)
        );
    }
}
