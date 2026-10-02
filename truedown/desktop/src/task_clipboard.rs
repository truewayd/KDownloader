use tauri::{Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Default)]
pub struct Clipboard(pub std::sync::Mutex<Option<Vec<String>>>);

fn parse(text: &str) -> Vec<String> {
    if text.len() > 65536 {
        return Vec::new();
    }
    let mut links = Vec::new();
    for token in text.split_whitespace().take(5000) {
        let token = token.trim_matches(|c| matches!(c, '<' | '>' | '"' | '\''));
        let Ok(url) = tauri::Url::parse(token) else {
            continue;
        };
        let valid = match url.scheme() {
            "http" | "https" => url.host_str().is_some(),
            "magnet" => url.query_pairs().any(|(key, value)| {
                key == "xt"
                    && (value.to_ascii_lowercase().starts_with("urn:btih:")
                        || value.to_ascii_lowercase().starts_with("urn:btmh:"))
            }),
            _ => false,
        };
        if valid && url.username().is_empty() && url.password().is_none() {
            let value = url.to_string();
            if !links.contains(&value) {
                links.push(value);
            }
        }
    }
    links
}

pub fn capture(app: &tauri::AppHandle) {
    let links = if app.state::<crate::windows::Windows>().suppress
        || app
            .state::<crate::drops::Drops>()
            .pending
            .lock()
            .unwrap()
            .is_some()
    {
        Vec::new()
    } else {
        app.clipboard()
            .read_text()
            .ok()
            .map(|text| parse(&text))
            .unwrap_or_default()
    };
    *app.state::<Clipboard>().0.lock().unwrap() = Some(links);
}

#[tauri::command]
pub fn take_task_clipboard(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Vec<String>, String> {
    if window.label() != "new-task" {
        return Err("Clipboard tasks belong to the new download form".into());
    }
    Ok(app
        .state::<Clipboard>()
        .0
        .lock()
        .unwrap()
        .take()
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_download_links_leave_the_native_clipboard() {
        assert_eq!(parse("private notes https://example.test/a https://example.test/a\nfile:///secret https://user:pass@example.test/ javascript:alert(1)"), vec!["https://example.test/a"]);
        assert_eq!(parse("magnet:?xt=urn:btih:abc").len(), 1);
        assert!(parse("magnet:?dn=abc").is_empty());
        assert!(parse(&"x".repeat(65537)).is_empty());
    }
}
