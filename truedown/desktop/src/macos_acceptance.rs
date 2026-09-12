// Fixed debug-only acceptance: no inspector, socket, arbitrary script input, or
// additional production WebView permissions. Tauri dispatches native operations
// onto its owning event loop; this worker never blocks that loop on a JS reply.
use std::{
    sync::mpsc::sync_channel,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};

struct Fixture {
    app: tauri::AppHandle,
    deadline: Instant,
    sequence: u64,
}

impl Fixture {
    fn window(&self, label: &str) -> Result<WebviewWindow, String> {
        self.app
            .get_webview_window(label)
            .ok_or_else(|| format!("missing window {label}"))
    }

    fn evaluate(
        &mut self,
        label: &str,
        expression: &str,
        timeout: Duration,
    ) -> Result<bool, String> {
        if Instant::now() >= self.deadline {
            return Err("acceptance deadline expired".into());
        }
        self.sequence += 1;
        let id = self.sequence;
        let script = format!(
            "{};beginMacosEvaluation({id},async()=>Boolean(await ({expression})))",
            include_str!("../tests/macos-evaluate.js")
        );
        self.window(label)?
            .eval(script)
            .map_err(|error| error.to_string())?;
        let end = self.deadline.min(Instant::now() + timeout);
        while let Some(remaining) = end.checked_duration_since(Instant::now()) {
            let (sender, replies) = sync_channel(1);
            // Poll from native code: hidden WebViews can suspend page timers.
            // A fresh callback channel cannot accept a late navigation result.
            self.window(label)?.eval_with_callback(
                format!("(()=>{{const r=window.__acceptanceResult;return r?.id==={id}&&r.done?r.ok:null}})()"),
                move |value| { let _ = sender.try_send(value); },
            ).map_err(|error| error.to_string())?;
            match replies.recv_timeout(remaining.min(Duration::from_secs(2))) {
                Ok(value) if value == "true" => return Ok(true),
                Ok(value) if value == "false" => return Ok(false),
                Ok(_) => std::thread::sleep(Duration::from_millis(150)),
                Err(_) => return Ok(false),
            }
        }
        Ok(false)
    }

    fn until(&mut self, label: &str, expression: &str) -> Result<(), String> {
        let end = self.deadline.min(Instant::now() + Duration::from_secs(30));
        while let Some(remaining) = end.checked_duration_since(Instant::now()) {
            if self.evaluate(label, expression, remaining.min(Duration::from_secs(2)))? {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        Err(format!("{label}: readiness timed out: {expression}"))
    }

    fn check(&mut self, label: &str, expression: &str) -> Result<(), String> {
        if self.evaluate(label, expression, Duration::from_secs(15))? {
            Ok(())
        } else {
            Err(format!("{label}: check failed: {expression}"))
        }
    }

    fn visibility(&self, label: &str, expected: bool) -> Result<(), String> {
        let end = self.deadline.min(Instant::now() + Duration::from_secs(5));
        while Instant::now() < end {
            if self
                .window(label)?
                .is_visible()
                .map_err(|error| error.to_string())?
                == expected
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(format!("{label}: expected visible={expected}"))
    }

    fn close(&self, label: &str) -> Result<(), String> {
        // Exercise the real CloseRequested handler, not the frontend hide command.
        self.window(label)?
            .close()
            .map_err(|error| error.to_string())?;
        self.visibility(label, false)
    }

    fn run(&mut self) -> Result<(), String> {
        self.visibility("main", false)?;
        // WKWebView may suspend a never-mapped page. Only the isolated CI app is shown.
        crate::show_main(&self.app);
        self.visibility("main", true)?;
        self.until("main", "window.__TRUEDOWN_PLATFORM__ === 'macos' && document.querySelector('#task-count') && window.__TAURI__")?;
        self.check("main", "(async()=>{const r=await window.__TAURI__.core.invoke('core_request',{request:{method:'GET',path:'/system/info'}});return JSON.parse(r.body).product==='TrueDown'})()")?;
        self.close("main")?;
        crate::show_main(&self.app);
        self.visibility("main", true)?;
        for label in ["settings", "new-task", "batch-task"] {
            let open = format!(
                "window.__TAURI__.core.invoke('open_auxiliary',{{kind:'{label}'}}).then(()=>true)"
            );
            self.check("main", &open)?;
            self.visibility(label, true)?;
            let ready = if label == "settings" {
                "settingsRendered.has('general') && !document.querySelector('[data-settings-page=general]').inert"
            } else {
                "nativeTaskFormReady && !nativeTaskPreferences.pending && !document.querySelector('#download-form').inert"
            };
            self.until(label, ready)?;
            self.check(
                label,
                "(()=>{window.__acceptanceDocument=true;return true})()",
            )?;
            let (edit, retained) = if label == "settings" {
                ("(()=>{const c=document.querySelector('#cfg-conns');c.value='9';c.dispatchEvent(new Event('input',{bubbles:true}));return true})()",
                 "document.querySelector('#cfg-conns').value==='9'")
            } else {
                ("(()=>{for(const [id,value] of [['m-link','https://example.com/retained-draft'],['m-headers','{\"X-Draft\":\"retained\"}']]){const c=document.getElementById(id);c.value=value;c.dispatchEvent(new Event('input',{bubbles:true}));}return true})()",
                 "document.querySelector('#m-link').value==='https://example.com/retained-draft' && document.querySelector('#m-headers').value==='{\"X-Draft\":\"retained\"}'")
            };
            self.check(label, edit)?;
            self.close(label)?;
            self.check("main", &open)?;
            self.visibility(label, true)?;
            self.until(label, ready)?;
            self.check(
                label,
                if label == "settings" {
                    "loadSettingsPage().then(()=>true)"
                } else {
                    "refreshNativeTaskPreferences().then(()=>true)"
                },
            )?;
            self.check(
                label,
                &format!("window.__acceptanceDocument === true && ({retained})"),
            )?;
            self.close(label)?;
        }
        if self.app.webview_windows().len() != 4 {
            return Err("auxiliary windows must remain singletons".into());
        }
        self.close("main")?;
        for label in ["main", "settings", "new-task", "batch-task"] {
            self.visibility(label, false)?;
        }
        Ok(())
    }
}

pub fn start(app: &tauri::AppHandle) {
    if std::env::var("TRUEDOWN_MACOS_ACCEPTANCE").as_deref() != Ok("1") {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut fixture = Fixture {
            app,
            deadline: Instant::now() + Duration::from_secs(120),
            sequence: 0,
        };
        match fixture.run() {
            Ok(()) => println!("macos_acceptance=ok launch=ok close_to_hide=ok settings_draft=ok task_form_drafts=ok"),
            Err(error) => eprintln!("macos_acceptance=failed {error}"),
        }
    });
}
