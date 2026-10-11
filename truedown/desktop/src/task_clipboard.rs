use tauri::{Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Default)]
pub struct Clipboard(pub std::sync::Mutex<Option<Vec<String>>>);

fn parse(text: &str) -> Vec<String> {
    if text.len() > 65536 {
        return Vec::new();
    }
    let mut links = Vec::new();
    let standalone: std::collections::HashSet<&str> = text.lines().map(str::trim).collect();
    for token in text
        .split(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '<' | '>'
                        | '"'
                        | '`'
                        | '\u{3002}'
                        | '\u{ff0c}'
                        | '\u{ff1b}'
                        | '\u{201c}'
                        | '\u{201d}'
                )
        })
        .take(20000)
    {
        let lower = token.to_ascii_lowercase();
        let Some(start) = ["https://", "http://", "magnet:?"]
            .iter()
            .filter_map(|scheme| lower.find(scheme))
            .min()
        else {
            continue;
        };
        let mut token = &token[start..];
        if !standalone.contains(token) {
            token = token.trim_end_matches(['.', ',', ';', '!', '\'', '\u{2019}']);
            for (open, close) in [('(', ')'), ('[', ']'), ('{', '}')] {
                let mut excess = token
                    .matches(close)
                    .count()
                    .saturating_sub(token.matches(open).count());
                while excess > 0 && token.ends_with(close) {
                    token = &token[..token.len() - 1];
                    excess -= 1;
                }
            }
        }
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
                if links.len() >= 5000 {
                    break;
                }
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
        assert_eq!(
            parse("https://example.test/download?token=abc!\nhttps://example.test/a)"),
            vec![
                "https://example.test/download?token=abc!",
                "https://example.test/a)"
            ]
        );
        assert_eq!(parse("[download](https://example.test/a_(b)) \u{94fe}\u{63a5}\u{ff1a}https://mega.nz/file/id#key\u{3002}"), vec!["https://example.test/a_(b)", "https://mega.nz/file/id#key"]);
        assert_eq!(
            parse("https://mega.nz/#!id!key https://mega.nz/#F!folder!key"),
            vec!["https://mega.nz/#!id!key", "https://mega.nz/#F!folder!key"]
        );
    }
}
