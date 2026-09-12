use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};

#[derive(Debug, PartialEq)]
pub enum Action {
    Main,
    NewTask,
}

pub fn action(event: &TrayIconEvent, windows: bool) -> Option<Action> {
    match event {
        // Windows sends a final Up after DoubleClick. Handling Down keeps that
        // release from returning focus to main after the task form opens.
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Down,
            ..
        } if windows => Some(Action::Main),
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } if windows => Some(Action::NewTask),
        TrayIconEvent::DoubleClick { .. } if !windows => Some(Action::Main),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: "test".into(),
            position: tauri::PhysicalPosition::new(0.0, 0.0),
            rect: tauri::Rect::default(),
            button,
            button_state,
        }
    }

    #[test]
    fn windows_double_click_finishes_at_task_form() {
        let double = TrayIconEvent::DoubleClick {
            id: "test".into(),
            position: tauri::PhysicalPosition::new(0.0, 0.0),
            rect: tauri::Rect::default(),
            button: MouseButton::Left,
        };
        let events = [
            click(MouseButton::Left, MouseButtonState::Down),
            click(MouseButton::Left, MouseButtonState::Up),
            double,
            click(MouseButton::Left, MouseButtonState::Up),
        ];
        assert_eq!(
            events
                .iter()
                .filter_map(|event| action(event, true))
                .collect::<Vec<_>>(),
            vec![Action::Main, Action::NewTask]
        );
        assert_eq!(action(&events[2], false), Some(Action::Main));
        assert_eq!(action(&events[0], false), None);
    }

    #[test]
    fn other_buttons_leave_native_menu_in_control() {
        for button in [MouseButton::Right, MouseButton::Middle] {
            assert_eq!(action(&click(button, MouseButtonState::Down), true), None);
            assert_eq!(action(&click(button, MouseButtonState::Up), true), None);
        }
    }
}
