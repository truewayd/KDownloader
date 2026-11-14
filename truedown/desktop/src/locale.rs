use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{menu::IconMenuItem, Manager};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn english() -> bool {
    ENGLISH.load(Ordering::SeqCst)
}

pub fn text<'a>(chinese: &'a str, english_text: &'a str) -> &'a str {
    if english() {
        english_text
    } else {
        chinese
    }
}

pub struct TrayLabels(pub Vec<(IconMenuItem<tauri::Wry>, &'static str, &'static str)>);

#[tauri::command]
pub fn set_application_language(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    language: String,
) -> Result<(), String> {
    if !matches!(window.label(), "main" | "settings") {
        return Err("Only application settings can change the language".into());
    }
    let english = match language.as_str() {
        "en" => true,
        "zh-CN" => false,
        _ => return Err("Unsupported application language".into()),
    };
    ENGLISH.store(english, Ordering::SeqCst);
    if let Some(labels) = app.try_state::<TrayLabels>() {
        for (item, chinese, english_text) in &labels.0 {
            item.set_text(text(chinese, english_text))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
